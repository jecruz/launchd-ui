use crate::agent_runtime;
use crate::error::AppError;
use crate::launchctl;
use crate::plist_util;
use crate::types::PlistConfig;
use crate::types::{JobListEntry, JobStatus, LaunchdJob};
use std::collections::HashMap;
use std::path::Path;

fn get_last_run_at(config: &PlistConfig) -> Option<String> {
    let paths = [&config.standard_out_path, &config.standard_error_path];
    let mut latest: Option<u64> = None;

    for path in paths.into_iter().flatten() {
        if let Ok(metadata) = std::fs::metadata(path) {
            if let Ok(modified) = metadata.modified() {
                if let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH) {
                    let millis = duration.as_secs() * 1000 + u64::from(duration.subsec_millis());
                    latest = Some(latest.map_or(millis, |prev: u64| prev.max(millis)));
                }
            }
        }
    }

    latest.map(|ms| ms.to_string())
}

fn ensure_user_agent(plist_path: &str) -> Result<(), AppError> {
    let home = dirs::home_dir().unwrap_or_default();
    let user_agents = home.join("Library/LaunchAgents");
    if !plist_path.starts_with(user_agents.to_str().unwrap_or("")) {
        return Err(AppError::Launchctl(
            "Cannot start/stop system agents or daemons. Only user agents (~/Library/LaunchAgents) can be managed."
                .to_string(),
        ));
    }
    Ok(())
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub enum ApprovedAgentActionKind {
    Start,
    Stop,
    Restart,
    Kickstart,
    Enable,
    Disable,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ApprovedAgentActionRequest {
    pub plist_path: String,
    pub label: String,
    pub command_proposal: String,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ApprovedAgentActionResult {
    pub action: ApprovedAgentActionKind,
    pub command: String,
    pub verified_status: JobStatus,
    pub verified_pid: Option<u32>,
    pub verified_last_exit_code: Option<i32>,
}

fn classify_command_proposal(command_proposal: &str) -> Result<ApprovedAgentActionKind, AppError> {
    let text = command_proposal.to_lowercase();
    let words: Vec<&str> = text
        .split(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '-'))
        .filter(|word| !word.is_empty())
        .collect();
    let has_word = |needle: &str| words.contains(&needle);
    let has_phrase = |needle: &str| text.contains(needle);

    let mut candidates = Vec::new();
    let is_restart = has_word("restart") || (has_word("bootout") && has_word("bootstrap"));

    if is_restart {
        candidates.push(ApprovedAgentActionKind::Restart);
    }
    if !is_restart
        && (has_phrase("launchctl bootstrap") || has_phrase("launchctl start") || has_word("start"))
    {
        candidates.push(ApprovedAgentActionKind::Start);
    }
    if !is_restart
        && (has_phrase("launchctl bootout")
            || has_phrase("launchctl stop")
            || has_word("stop")
            || has_word("unload"))
    {
        candidates.push(ApprovedAgentActionKind::Stop);
    }
    if has_phrase("launchctl kickstart") || has_word("kickstart") || has_word("-k") {
        candidates.push(ApprovedAgentActionKind::Kickstart);
    }
    if has_phrase("launchctl enable") || has_word("enable") {
        candidates.push(ApprovedAgentActionKind::Enable);
    }
    if has_phrase("launchctl disable") || has_word("disable") {
        candidates.push(ApprovedAgentActionKind::Disable);
    }

    candidates.dedup();

    match candidates.as_slice() {
        [action] => Ok(action.clone()),
        [] => Err(AppError::AgentRuntime(
            "command proposal did not match a supported launchd action".to_string(),
        )),
        _ => Err(AppError::AgentRuntime(
            "command proposal matched multiple launchd actions".to_string(),
        )),
    }
}

fn approved_action_command(
    action: &ApprovedAgentActionKind,
    label: &str,
    plist_path: &str,
) -> String {
    let gui_target = launchctl::gui_target();
    let service_target = launchctl::service_target(label);

    match action {
        ApprovedAgentActionKind::Start => {
            format!("launchctl bootstrap {gui_target} {plist_path}")
        }
        ApprovedAgentActionKind::Stop => {
            format!("launchctl bootout {gui_target} {plist_path}")
        }
        ApprovedAgentActionKind::Restart => {
            format!(
                "launchctl bootout {gui_target} {plist_path} && launchctl bootstrap {gui_target} {plist_path}"
            )
        }
        ApprovedAgentActionKind::Kickstart => {
            format!("launchctl kickstart -k {service_target}")
        }
        ApprovedAgentActionKind::Enable => {
            format!("launchctl enable {service_target}")
        }
        ApprovedAgentActionKind::Disable => {
            format!("launchctl disable {service_target}")
        }
    }
}

#[tauri::command]
pub async fn list_jobs() -> Result<Vec<JobListEntry>, AppError> {
    let plist_files = plist_util::scan_plist_files();
    let loaded = launchctl::list_loaded().unwrap_or_default();

    let loaded_map: HashMap<String, &launchctl::LoadedService> =
        loaded.iter().map(|s| (s.label.clone(), s)).collect();

    let mut entries = Vec::new();
    for (path, source) in plist_files {
        let config = match plist_util::parse_plist(&path) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let (status, pid, exit_code) = if let Some(svc) = loaded_map.get(&config.label) {
            let status = if svc.pid.is_some() {
                JobStatus::Running
            } else {
                JobStatus::Loaded
            };
            (status, svc.pid, svc.last_exit_code)
        } else {
            (JobStatus::Unloaded, None, None)
        };

        let last_run_at = get_last_run_at(&config);
        entries.push(JobListEntry {
            label: config.label,
            pid,
            last_exit_code: exit_code,
            plist_path: path,
            source,
            status,
            last_run_at,
        });
    }

    entries.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(entries)
}

#[tauri::command]
pub async fn get_job_detail(plist_path: String) -> Result<LaunchdJob, AppError> {
    if !std::path::Path::new(&plist_path).exists() {
        return Err(AppError::NotFound(plist_path));
    }

    let plist = plist_util::parse_plist(&plist_path)?;
    let loaded = launchctl::list_loaded().unwrap_or_default();

    let svc = loaded.iter().find(|s| s.label == plist.label);
    let (status, pid, exit_code) = match svc {
        Some(s) => {
            let status = if s.pid.is_some() {
                JobStatus::Running
            } else {
                JobStatus::Loaded
            };
            (status, s.pid, s.last_exit_code)
        }
        None => (JobStatus::Unloaded, None, None),
    };

    let source = if plist_path.contains("/Library/LaunchDaemons") {
        crate::types::JobSource::SystemDaemon
    } else if plist_path.starts_with("/Library/LaunchAgents") {
        crate::types::JobSource::SystemAgent
    } else {
        crate::types::JobSource::UserAgent
    };

    let last_run_at = get_last_run_at(&plist);
    Ok(LaunchdJob {
        label: plist.label.clone(),
        plist_path,
        source,
        status,
        pid,
        last_exit_code: exit_code,
        plist,
        last_run_at,
    })
}

#[tauri::command]
pub async fn start_job(plist_path: String) -> Result<(), AppError> {
    ensure_user_agent(&plist_path)?;
    // Unload first to avoid "already loaded" or stale state
    let _ = launchctl::bootout(&plist_path);
    launchctl::bootstrap(&plist_path)
}

#[tauri::command]
pub async fn stop_job(plist_path: String) -> Result<(), AppError> {
    ensure_user_agent(&plist_path)?;
    launchctl::bootout(&plist_path)
}

#[tauri::command]
pub async fn restart_job(plist_path: String) -> Result<(), AppError> {
    ensure_user_agent(&plist_path)?;
    let _ = launchctl::bootout(&plist_path);
    launchctl::bootstrap(&plist_path)
}

#[tauri::command]
pub async fn kickstart_job(label: String, plist_path: String) -> Result<(), AppError> {
    ensure_user_agent(&plist_path)?;
    // Ensure the service is loaded before kickstarting
    let loaded = launchctl::list_loaded().unwrap_or_default();
    let is_loaded = loaded.iter().any(|s| s.label == label);
    if !is_loaded {
        launchctl::bootstrap(&plist_path)?;
    }
    launchctl::kickstart(&label)
}

#[tauri::command]
pub async fn enable_job(label: String, plist_path: String) -> Result<(), AppError> {
    ensure_user_agent(&plist_path)?;
    launchctl::enable(&label)
}

#[tauri::command]
pub async fn disable_job(label: String, plist_path: String) -> Result<(), AppError> {
    ensure_user_agent(&plist_path)?;
    launchctl::disable(&label)
}

#[tauri::command]
pub async fn save_job(plist_path: String, config: PlistConfig) -> Result<(), AppError> {
    plist_util::write_plist(&plist_path, &config)
}

#[tauri::command]
pub async fn create_job(label: String, config: PlistConfig) -> Result<String, AppError> {
    let agents_dir = plist_util::get_user_agents_dir();
    if !agents_dir.exists() {
        std::fs::create_dir_all(&agents_dir)?;
    }
    // Create log directories if log paths are set
    for log_path in [&config.standard_out_path, &config.standard_error_path]
        .into_iter()
        .flatten()
    {
        if let Some(parent) = std::path::Path::new(log_path).parent() {
            if !parent.exists() {
                std::fs::create_dir_all(parent)?;
            }
        }
    }
    let path = agents_dir.join(format!("{label}.plist"));
    let path_str = path
        .to_str()
        .ok_or_else(|| AppError::Plist("invalid path".to_string()))?
        .to_string();
    plist_util::write_plist(&path_str, &config)?;
    Ok(path_str)
}

#[tauri::command]
pub async fn save_raw_plist(plist_path: String, xml: String) -> Result<(), AppError> {
    plist_util::write_raw_plist(&plist_path, &xml)
}

#[tauri::command]
pub async fn delete_job(plist_path: String, label: String) -> Result<(), AppError> {
    let _ = launchctl::bootout(&plist_path);
    let _ = launchctl::disable(&label);
    if std::path::Path::new(&plist_path).exists() {
        std::fs::remove_file(&plist_path)?;
    }
    Ok(())
}

#[derive(serde::Serialize)]
pub struct LogFileResult {
    content: String,
    modified_at: Option<String>,
}

#[tauri::command]
pub async fn read_log_file(
    path: String,
    tail_lines: Option<usize>,
) -> Result<LogFileResult, AppError> {
    if !std::path::Path::new(&path).exists() {
        return Err(AppError::NotFound(format!("log file not found: {path}")));
    }

    let metadata = std::fs::metadata(&path)?;
    let modified_at = metadata
        .modified()
        .ok()
        .and_then(|t| {
            let duration = t.duration_since(std::time::UNIX_EPOCH).ok()?;
            Some(duration.as_secs())
        })
        .map(|secs| {
            // ISO 8601 timestamp in UTC (frontend will format to local)
            let secs_i64 = secs as i64;
            format!(
                "{}",
                secs_i64 * 1000 // milliseconds for JS Date
            )
        });

    let content = std::fs::read_to_string(&path)?;
    let content = match tail_lines {
        Some(n) => {
            let lines: Vec<&str> = content.lines().collect();
            let start = lines.len().saturating_sub(n);
            lines[start..].join("\n")
        }
        None => content,
    };

    Ok(LogFileResult {
        content,
        modified_at,
    })
}

#[tauri::command]
pub async fn clear_log_file(path: String) -> Result<(), AppError> {
    if !std::path::Path::new(&path).exists() {
        return Err(AppError::NotFound(format!("log file not found: {path}")));
    }
    std::fs::write(&path, "")?;
    Ok(())
}

#[tauri::command]
pub async fn open_log_in_editor(path: String) -> Result<(), AppError> {
    std::process::Command::new("open")
        .arg("-t")
        .arg(&path)
        .spawn()?;
    Ok(())
}

#[tauri::command]
pub async fn get_home_dir() -> Result<String, AppError> {
    dirs::home_dir()
        .and_then(|p| p.to_str().map(String::from))
        .ok_or_else(|| AppError::Launchctl("could not determine home directory".to_string()))
}

#[tauri::command]
pub async fn reveal_in_finder(path: String) -> Result<(), AppError> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(&path)
        .spawn()?;
    Ok(())
}

#[tauri::command]
pub async fn get_agent_runtime_settings() -> Result<agent_runtime::AgentRuntimeSettings, AppError> {
    agent_runtime::load_agent_runtime_settings()
}

#[tauri::command]
pub async fn save_agent_runtime_settings(
    settings: agent_runtime::AgentRuntimeSettings,
) -> Result<agent_runtime::AgentRuntimeSettings, AppError> {
    agent_runtime::save_agent_runtime_settings(&settings)?;
    Ok(settings)
}

#[tauri::command]
pub async fn run_agent_prompt(
    request: agent_runtime::AgentPromptRequest,
) -> Result<agent_runtime::AgentRuntimeResult, AppError> {
    let settings = agent_runtime::load_agent_runtime_settings()?;
    agent_runtime::run_agent_prompt(&settings, &request)
}

#[tauri::command]
pub async fn get_agent_runtime_summary() -> Result<agent_runtime::AgentRuntimeSummary, AppError> {
    let settings = agent_runtime::load_agent_runtime_settings()?;
    Ok(agent_runtime::summarize_settings(&settings))
}

#[tauri::command]
pub async fn apply_approved_agent_action(
    request: ApprovedAgentActionRequest,
) -> Result<ApprovedAgentActionResult, AppError> {
    ensure_user_agent(&request.plist_path)?;

    if !Path::new(&request.plist_path).exists() {
        return Err(AppError::NotFound(request.plist_path));
    }

    let action = classify_command_proposal(&request.command_proposal)?;
    let command = match action {
        ApprovedAgentActionKind::Start => {
            start_job(request.plist_path.clone()).await?;
            approved_action_command(&action, &request.label, &request.plist_path)
        }
        ApprovedAgentActionKind::Stop => {
            stop_job(request.plist_path.clone()).await?;
            approved_action_command(&action, &request.label, &request.plist_path)
        }
        ApprovedAgentActionKind::Restart => {
            restart_job(request.plist_path.clone()).await?;
            approved_action_command(&action, &request.label, &request.plist_path)
        }
        ApprovedAgentActionKind::Kickstart => {
            kickstart_job(request.label.clone(), request.plist_path.clone()).await?;
            approved_action_command(&action, &request.label, &request.plist_path)
        }
        ApprovedAgentActionKind::Enable => {
            enable_job(request.label.clone(), request.plist_path.clone()).await?;
            approved_action_command(&action, &request.label, &request.plist_path)
        }
        ApprovedAgentActionKind::Disable => {
            disable_job(request.label.clone(), request.plist_path.clone()).await?;
            approved_action_command(&action, &request.label, &request.plist_path)
        }
    };
    let verified = get_job_detail(request.plist_path.clone()).await?;

    Ok(ApprovedAgentActionResult {
        action,
        command,
        verified_status: verified.status,
        verified_pid: verified.pid,
        verified_last_exit_code: verified.last_exit_code,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_user_agent_accepts_home_launch_agents() {
        let path = dirs::home_dir()
            .expect("home dir")
            .join("Library/LaunchAgents/com.example.test.plist");

        assert!(ensure_user_agent(path.to_str().expect("path str")).is_ok());
    }

    #[test]
    fn ensure_user_agent_rejects_system_launch_agents() {
        let result = ensure_user_agent("/Library/LaunchAgents/com.example.test.plist");

        assert!(result.is_err());
    }

    #[test]
    fn classifies_supported_command_proposals() {
        let cases = [
            (
                "launchctl bootstrap gui/501 /Users/me/Library/LaunchAgents/com.example.plist",
                ApprovedAgentActionKind::Start,
            ),
            (
                "launchctl bootout gui/501 /Users/me/Library/LaunchAgents/com.example.plist",
                ApprovedAgentActionKind::Stop,
            ),
            ("restart the selected job", ApprovedAgentActionKind::Restart),
            (
                "launchctl kickstart -k gui/501/com.example",
                ApprovedAgentActionKind::Kickstart,
            ),
            (
                "launchctl enable gui/501/com.example",
                ApprovedAgentActionKind::Enable,
            ),
            (
                "launchctl disable gui/501/com.example",
                ApprovedAgentActionKind::Disable,
            ),
        ];

        for (proposal, expected) in cases {
            assert_eq!(classify_command_proposal(proposal).unwrap(), expected);
        }
    }

    #[test]
    fn rejects_ambiguous_command_proposals() {
        let result = classify_command_proposal(
            "launchctl disable gui/501/com.example, then launchctl enable gui/501/com.example",
        );

        assert!(
            matches!(result, Err(AppError::AgentRuntime(message)) if message.contains("multiple"))
        );
    }

    #[test]
    fn rejects_unsupported_shell_text() {
        let result = classify_command_proposal("rm -rf ~/Library/LaunchAgents/com.example.plist");

        assert!(
            matches!(result, Err(AppError::AgentRuntime(message)) if message.contains("supported"))
        );
    }

    #[test]
    fn approved_action_command_uses_exact_targets() {
        let command = approved_action_command(
            &ApprovedAgentActionKind::Kickstart,
            "com.example.test",
            "/Users/me/Library/LaunchAgents/com.example.test.plist",
        );

        assert!(command.starts_with("launchctl kickstart -k gui/"));
        assert!(command.ends_with("/com.example.test"));
        assert!(!command.contains("<uid>"));
    }

    #[test]
    fn approved_action_command_uses_plist_path_for_bootstrap() {
        let plist_path = "/Users/me/Library/LaunchAgents/com.example.test.plist";
        let command = approved_action_command(
            &ApprovedAgentActionKind::Start,
            "com.example.test",
            plist_path,
        );

        assert!(command.starts_with("launchctl bootstrap gui/"));
        assert!(command.ends_with(plist_path));
        assert!(!command.contains("<uid>"));
    }
}
