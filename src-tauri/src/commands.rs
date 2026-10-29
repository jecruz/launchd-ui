use crate::agent_runtime;
use crate::error::AppError;
use crate::launchctl;
use crate::plist_util;
use crate::service_overlays;
use crate::types::PlistConfig;
use crate::types::{
    JobListEntry, JobSource, JobStatus, LaunchControlMetadata, LaunchdJob, LogPaths,
    ServiceDiagnosis, ServiceRepairSuggestion,
};
use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};

/// Complete an explicit quit only after the frontend has flushed its pending state.
#[tauri::command]
pub fn finish_quit(app: tauri::AppHandle) {
    crate::QUIT_APPROVED.store(true, std::sync::atomic::Ordering::SeqCst);
    app.exit(0);
}

fn current_epoch_millis() -> String {
    let now = std::time::SystemTime::now();
    let millis = now
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default();
    millis.to_string()
}

fn read_tail(path: &str, owner: u32, limit: usize) -> Result<(String, Option<String>), AppError> {
    const MAX_BYTES: u64 = 256 * 1024;
    let mut file = crate::user_agent::open_log_for_read(path, owner)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() {
        return Err(AppError::Plist("Logs must be regular files.".into()));
    }
    let offset = metadata.len().saturating_sub(MAX_BYTES);
    file.seek(SeekFrom::Start(offset))?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES).read_to_end(&mut bytes)?;
    let content = String::from_utf8_lossy(&bytes);
    let content = if offset > 0 {
        content
            .split_once('\n')
            .map(|(_, tail)| tail)
            .unwrap_or(&content)
    } else {
        &content
    };
    let lines: Vec<_> = content.lines().collect();
    let content = lines[lines.len().saturating_sub(limit.min(2000))..].join("\n");
    let modified = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().to_string());
    Ok((content, modified))
}

fn read_declared_log(
    config: &PlistConfig,
    path: &str,
    owner: u32,
    limit: usize,
) -> Result<(String, Option<String>), AppError> {
    if ![&config.standard_out_path, &config.standard_error_path]
        .into_iter()
        .flatten()
        .any(|declared| declared == path)
    {
        return Err(AppError::Plist(
            "Requested log is not declared by its plist.".into(),
        ));
    }
    read_tail(path, owner, limit)
}

fn parse_program_port(program_arguments: Option<&Vec<String>>) -> Option<u16> {
    let args = program_arguments?;
    let mut iter = args.iter().peekable();
    while let Some(arg) = iter.next() {
        if let Some(value) = arg.strip_prefix("--port=")
            && let Ok(port) = value.parse::<u16>()
        {
            return Some(port);
        }
        if arg == "--port"
            && let Some(next) = iter.peek()
            && let Ok(port) = next.parse::<u16>()
        {
            return Some(port);
        }
        if let Some(value) = arg.strip_prefix("port=")
            && let Ok(port) = value.parse::<u16>()
        {
            return Some(port);
        }
    }
    None
}

fn get_last_run_at(config: &PlistConfig) -> Option<String> {
    let paths = [&config.standard_out_path, &config.standard_error_path];
    let mut latest: Option<u64> = None;

    for path in paths.into_iter().flatten() {
        if let Ok(metadata) = std::fs::metadata(path)
            && let Ok(modified) = metadata.modified()
            && let Ok(duration) = modified.duration_since(std::time::UNIX_EPOCH)
        {
            let millis = duration.as_secs() * 1000 + u64::from(duration.subsec_millis());
            latest = Some(latest.map_or(millis, |prev: u64| prev.max(millis)));
        }
    }

    latest.map(|ms| ms.to_string())
}

/// True when a program/argument path looks like a vendor app binary rather than a
/// user-authored script: it lives in /Applications, inside an `.app` bundle, or under
/// `~/Library/Application Support` (where auto-updaters install themselves).
fn is_app_path(path: &str) -> bool {
    path.starts_with("/Applications/")
        || path.contains(".app/")
        || path.contains("/Library/Application Support/")
}

/// True when `s` references a path under the user's home directory that is not itself an
/// app-bundle path. Used to confirm the agent actually runs a script the user owns.
/// `s` may be a bare path argument or a `zsh -c` command string with the path inside it.
fn references_home_path(s: &str, home: &str) -> bool {
    (s.contains(&format!("{home}/"))
        || s.contains("~/")
        || s.contains("$HOME/")
        || s.contains("${HOME}/"))
        && !is_app_path(s)
}

/// Classifies a user agent as a "Home" agent: a user-authored automation (e.g. a shell or
/// python script under `~/`) rather than a vendor-installed app. Requires that the launched
/// executable is not an app bundle AND that some program path points under the home directory.
fn is_home_agent(source: &JobSource, config: &PlistConfig) -> bool {
    if *source != JobSource::UserAgent {
        return false;
    }
    let home = match dirs::home_dir() {
        Some(h) => h.to_string_lossy().into_owned(),
        None => return false,
    };
    if home.is_empty() {
        return false;
    }

    // The executable actually launched: `Program`, else the first `ProgramArguments` entry
    // (which for scripts is usually the interpreter, e.g. /bin/bash).
    let executable = config.program.clone().or_else(|| {
        config
            .program_arguments
            .as_ref()
            .and_then(|a| a.first().cloned())
    });
    let Some(exe) = executable else {
        return false;
    };
    if is_app_path(&exe) {
        return false;
    }

    // Require at least one referenced path under the user's home directory (the script itself).
    let mut strings: Vec<&str> = Vec::new();
    if let Some(ref p) = config.program {
        strings.push(p);
    }
    if let Some(ref args) = config.program_arguments {
        strings.extend(args.iter().map(String::as_str));
    }
    strings.iter().any(|s| references_home_path(s, &home))
        || (config
            .working_directory
            .as_deref()
            .is_some_and(|cwd| std::path::Path::new(cwd).starts_with(&home))
            && strings
                .iter()
                .any(|s| !s.is_empty() && !s.starts_with('/') && !s.starts_with('-')))
}

#[cfg(test)]
fn ensure_user_agent(plist_path: &str) -> Result<(), AppError> {
    crate::user_agent::path(plist_path, false).map(|_| ())
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
    #[serde(default)]
    pub auto_apply: bool,
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
    if command_proposal
        .chars()
        .any(|c| matches!(c, ';' | '|' | '&' | '`' | '$' | '\n' | '\r' | '<' | '>'))
    {
        return Err(AppError::AgentRuntime(
            "unsupported shell syntax in command proposal".into(),
        ));
    }
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

fn validate_execution_policy(
    action: &ApprovedAgentActionKind,
    auto_apply: bool,
) -> Result<(), AppError> {
    if auto_apply
        && !matches!(
            action,
            ApprovedAgentActionKind::Start | ApprovedAgentActionKind::Kickstart
        )
    {
        return Err(AppError::AgentRuntime(
            "Automatic execution is limited to user-agent start and kickstart actions.".into(),
        ));
    }
    Ok(())
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
    service_overlays::recover_pending()?;
    let plist_files = plist_util::scan_plist_files();
    let loaded = launchctl::list_loaded().unwrap_or_default();
    let overlays = service_overlays::load_service_overrides()?;

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

        let metadata = service_overlays::merge_metadata(&config.metadata, overlays.get(&path));
        let last_run_at = get_last_run_at(&config);
        let home_agent = is_home_agent(&source, &config);
        entries.push(JobListEntry {
            label: config.label,
            pid,
            last_exit_code: exit_code,
            plist_path: path,
            source,
            status,
            last_run_at,
            metadata,
            is_home_agent: home_agent,
            log_paths: LogPaths {
                stdout: config.standard_out_path.clone(),
                stderr: config.standard_error_path.clone(),
            },
        });
    }

    entries.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(entries)
}

fn listed_plist_in(
    plist_path: &str,
    listed: &[(String, JobSource)],
    user_root: &std::path::Path,
) -> Result<(JobSource, crate::user_agent::CheckedPlist), AppError> {
    let source = listed
        .iter()
        .find(|(known, _)| known == plist_path)
        .map(|(_, source)| source.clone())
        .ok_or_else(|| {
            AppError::NotFound(format!(
                "Owner must be a listed launchd plist: {plist_path}"
            ))
        })?;
    let (root, owner) = match source {
        JobSource::UserAgent => (user_root, unsafe { libc::geteuid() }),
        JobSource::SystemAgent => (std::path::Path::new("/Library/LaunchAgents"), 0),
        JobSource::SystemDaemon => (std::path::Path::new("/Library/LaunchDaemons"), 0),
    };
    let checked = crate::user_agent::read_in(root, std::path::Path::new(plist_path), owner)?;
    Ok((source, checked))
}

fn listed_plist(
    plist_path: &str,
) -> Result<(JobSource, crate::user_agent::CheckedPlist), AppError> {
    listed_plist_in(
        plist_path,
        &plist_util::scan_plist_files(),
        &plist_util::get_user_agents_dir(),
    )
}

fn detail_for_plist(
    source: JobSource,
    checked: &crate::user_agent::CheckedPlist,
) -> Result<LaunchdJob, AppError> {
    checked.ensure_current()?;
    service_overlays::recover_pending()?;
    checked.ensure_current()?;
    let plist_path = checked.path();
    let plist = checked.config().clone();
    let metadata = service_overlays::merge_metadata_by_path(&plist_path, &plist.metadata)?;
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

    let last_run_at = get_last_run_at(&plist);
    checked.ensure_current()?;
    Ok(LaunchdJob {
        label: plist.label.clone(),
        plist_path,
        source,
        status,
        pid,
        last_exit_code: exit_code,
        plist: PlistConfig { metadata, ..plist },
        last_run_at,
    })
}

/// Return details only for a listed plist with the same containment and identity checks as mutations.
#[tauri::command]
pub async fn get_job_detail(plist_path: String) -> Result<LaunchdJob, AppError> {
    let (source, checked) = listed_plist(&plist_path)?;
    detail_for_plist(source, &checked)
}

fn probe_checked_health(
    checked: &crate::user_agent::CheckedPlist,
    job: &LaunchdJob,
) -> Result<(String, String), AppError> {
    checked.ensure_current()?;
    let result = run_health_check_command(&job.label, &job.plist, &job.plist.metadata);
    checked.ensure_current()?;
    result
}

fn read_checked_log(
    checked: &crate::user_agent::CheckedPlist,
    path: &str,
    limit: usize,
) -> Result<(String, Option<String>), AppError> {
    checked.ensure_current()?;
    let result = read_declared_log(checked.config(), path, checked.owner(), limit);
    checked.ensure_current()?;
    result
}

fn diagnosis_excerpt(
    checked: &crate::user_agent::CheckedPlist,
    path: Option<&str>,
    limit: usize,
) -> Result<Option<String>, AppError> {
    let Some(path) = path else { return Ok(None) };
    match read_checked_log(checked, path, limit) {
        Ok((content, _)) => Ok((!content.trim().is_empty()).then_some(content)),
        Err(AppError::Io(error)) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn candidate_health_urls(
    label: &str,
    plist: &PlistConfig,
    metadata: &crate::types::LaunchControlMetadata,
) -> Vec<String> {
    let mut candidates = Vec::new();
    let derived_port = parse_program_port(plist.program_arguments.as_ref());
    if let Some(port) = derived_port {
        candidates.push(format!("http://127.0.0.1:{port}/health"));
        candidates.push(format!("http://127.0.0.1:{port}/status"));
        candidates.push(format!("http://127.0.0.1:{port}/"));
    }

    for port in &metadata.ports {
        if Some(*port) == derived_port {
            continue;
        }
        candidates.push(format!("http://127.0.0.1:{port}/health"));
        candidates.push(format!("http://127.0.0.1:{port}/status"));
        candidates.push(format!("http://127.0.0.1:{port}/"));
    }

    let label_lower = label.to_lowercase();
    if candidates.is_empty() && label_lower.contains("uptime-kuma") {
        candidates.push("http://127.0.0.1:3001/".to_string());
        candidates.push("http://127.0.0.1:3001/status".to_string());
    }

    candidates
}

fn run_health_check_command(
    label: &str,
    plist: &PlistConfig,
    metadata: &crate::types::LaunchControlMetadata,
) -> Result<(String, String), AppError> {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let probe_url = |value: &str| crate::health_probe::probe_before(value, deadline);
    if let Some(url) = metadata.health_check_url.as_ref() {
        let (healthy, detail) = probe_url(url)?;
        if healthy {
            return Ok(("healthy".to_string(), detail));
        }

        return Ok(("unhealthy".to_string(), detail));
    }

    if metadata.health_check_command.is_some() {
        return Ok((
            "unknown".to_string(),
            "Command-based health checks are disabled; configure a health check URL instead."
                .to_string(),
        ));
    }

    for url in candidate_health_urls(label, plist, metadata) {
        let (healthy, detail) = probe_url(&url)?;
        if healthy {
            return Ok(("healthy".to_string(), detail));
        }
    }

    let mut detail = String::from("No explicit health check configured");
    if !metadata.ports.is_empty() {
        let ports = metadata
            .ports
            .iter()
            .map(|port| port.to_string())
            .collect::<Vec<_>>()
            .join(", ");
        detail.push_str(&format!("; ports available: {ports}"));
    }
    if label.to_lowercase().contains("uptime-kuma") {
        if let Some(port) = parse_program_port(plist.program_arguments.as_ref()) {
            detail.push_str(&format!("; tried declared port {port}"));
        } else {
            detail.push_str("; tried uptime-kuma defaults on port 3001");
        }
    }

    Ok(("unknown".to_string(), detail))
}

fn suggest_repair(
    job: &LaunchdJob,
    stderr_excerpt: Option<&str>,
    stdout_excerpt: Option<&str>,
) -> ServiceDiagnosis {
    let mut likely_causes = Vec::new();
    let mut suggestions = Vec::new();
    let stderr_lower = stderr_excerpt.unwrap_or("").to_lowercase();
    let stdout_lower = stdout_excerpt.unwrap_or("").to_lowercase();
    let label_lower = job.label.to_lowercase();
    let metadata = &job.plist.metadata;
    let mut observed = metadata.clone();
    let fresh = metadata
        .last_health_check_at
        .as_deref()
        .and_then(|value| value.parse::<u128>().ok())
        .is_some_and(|time| {
            current_epoch_millis()
                .parse::<u128>()
                .is_ok_and(|now| time <= now && now - time <= 300_000)
        });
    let fresh_success = fresh
        && job.status == JobStatus::Running
        && metadata.health_status.as_deref() == Some("healthy");
    if !fresh_success && job.last_exit_code.is_some_and(|code| code != 0) {
        observed.health_status = Some("unhealthy".into());
        observed.health_detail = Some("The last process exit was nonzero.".into());
    } else if !fresh
        || (job.status != JobStatus::Running
            && observed.health_status.as_deref() == Some("healthy"))
    {
        observed.health_status = Some("unknown".into());
        observed.health_detail = Some("Health observation is missing, stale, or no longer backed by a running process; run a fresh probe.".into());
    }
    let metadata = &observed;
    if !fresh_success && job.last_exit_code.is_some() && job.last_exit_code != Some(0) {
        likely_causes.push(format!("The last exit code was {:?}", job.last_exit_code));
    }
    if stderr_lower.contains("connection refused") || stdout_lower.contains("connection refused") {
        likely_causes
            .push("The service is running but not reachable on the expected port.".to_string());
    }
    if stderr_lower.contains("no such file") || stderr_lower.contains("not found") {
        likely_causes.push("A command, working directory, or path is missing.".to_string());
    }
    if stderr_lower.contains("permission denied") {
        likely_causes
            .push("The process lacks permission to open a file or bind a resource.".to_string());
    }
    if stderr_lower.contains("address already in use")
        || stdout_lower.contains("address already in use")
    {
        likely_causes.push("The configured port is already occupied.".to_string());
    }
    if label_lower.contains("uptime-kuma") {
        let declared_port =
            parse_program_port(job.plist.program_arguments.as_ref()).unwrap_or(3001);
        likely_causes.push(format!(
            "Uptime Kuma usually serves HTTP on port {declared_port}."
        ));
        if metadata.health_check_url.is_none() {
            suggestions.push(ServiceRepairSuggestion {
                title: "Set a health URL".to_string(),
                detail: format!(
                    "Add `http://127.0.0.1:{declared_port}/` as the health check URL so Daemonic can verify the service."
                ),
                kind: "metadata".to_string(),
            });
        }
        if !metadata.ports.contains(&declared_port) {
            suggestions.push(ServiceRepairSuggestion {
                title: format!("Declare port {declared_port}"),
                detail: format!(
                    "Add {declared_port} to the service ports so the dashboard can surface the listener and health probes."
                ),
                kind: "metadata".to_string(),
            });
        }
        if metadata.template.is_none() {
            suggestions.push(ServiceRepairSuggestion {
                title: "Use the web template".to_string(),
                detail: "Mark the service as a web service so the metadata stays consistent across repairs.".to_string(),
                kind: "template".to_string(),
            });
        }
    }
    if job.plist.working_directory.is_none() && job.plist.program_arguments.is_some() {
        suggestions.push(ServiceRepairSuggestion {
            title: "Set a working directory".to_string(),
            detail: "Some services fail when launchd starts them outside their expected project directory.".to_string(),
            kind: "plist".to_string(),
        });
    }
    if job.plist.standard_error_path.is_none() {
        suggestions.push(ServiceRepairSuggestion {
            title: "Write stderr to a file".to_string(),
            detail:
                "Configure a stderr log path so Daemonic can surface the failure details directly."
                    .to_string(),
            kind: "plist".to_string(),
        });
    }

    let summary = if !fresh_success && job.last_exit_code.is_some_and(|code| code != 0) {
        "The service exited with a nonzero status; inspect its current configuration and logs."
            .to_string()
    } else if metadata.health_status.as_deref() == Some("healthy") {
        if let Some(detail) = metadata.health_detail.as_ref() {
            format!("The service is healthy. {detail}")
        } else {
            "The service is healthy.".to_string()
        }
    } else if metadata.health_status.as_deref() == Some("unhealthy") {
        format!(
            "The service is unhealthy. {}",
            metadata
                .health_detail
                .as_deref()
                .unwrap_or("The configured health check failed.")
        )
    } else if let Some(stderr) = stderr_excerpt {
        if stderr_lower.contains("connection refused") {
            "The service is failing a health check or cannot be reached on its expected port."
                .to_string()
        } else if stderr_lower.contains("not found") || stderr_lower.contains("no such file") {
            "The service appears to be failing because a path or command is missing.".to_string()
        } else if stderr_lower.contains("permission denied") {
            "The service appears to be failing due to a permissions problem.".to_string()
        } else if label_lower.contains("uptime-kuma") {
            "Uptime Kuma is likely failing because its health/port metadata is incomplete."
                .to_string()
        } else {
            format!(
                "Health is unknown; stderr is diagnostic context and is not proof of current failure: {stderr}"
            )
        }
    } else if label_lower.contains("uptime-kuma") {
        let declared_port =
            parse_program_port(job.plist.program_arguments.as_ref()).unwrap_or(3001);
        format!("Uptime Kuma likely needs port {declared_port} and an explicit health URL.")
    } else if metadata.health_status.as_deref() == Some("unknown")
        || metadata.health_status.is_none()
    {
        if label_lower.contains("hermes.gateway") {
            "Hermes Gateway is running but has no explicit health check configured yet.".to_string()
        } else {
            "The service health is unknown; no explicit health check is configured yet.".to_string()
        }
    } else {
        "The service is unhealthy, but no stderr excerpt is available yet.".to_string()
    };

    let suggested_metadata = if label_lower.contains("uptime-kuma") {
        let declared_port =
            parse_program_port(job.plist.program_arguments.as_ref()).unwrap_or(3001);
        Some(LaunchControlMetadata {
            group: metadata
                .group
                .clone()
                .or_else(|| Some("CAISS System".to_string())),
            tags: if metadata.tags.is_empty() {
                vec!["uptime-kuma".to_string(), "monitoring".to_string()]
            } else {
                metadata.tags.clone()
            },
            managed_by: metadata
                .managed_by
                .clone()
                .or_else(|| Some("Daemonic".to_string())),
            description: metadata
                .description
                .clone()
                .or_else(|| Some("Uptime Kuma service".to_string())),
            environment: metadata
                .environment
                .clone()
                .or_else(|| Some("local".to_string())),
            health_check_url: metadata
                .health_check_url
                .clone()
                .or_else(|| Some(format!("http://127.0.0.1:{declared_port}/"))),
            health_check_command: metadata.health_check_command.clone(),
            ports: {
                let mut ports = metadata.ports.clone();
                if !ports.contains(&declared_port) {
                    ports.push(declared_port);
                }
                ports
            },
            template: metadata
                .template
                .clone()
                .or_else(|| Some("web".to_string())),
            migration_hint: metadata
                .migration_hint
                .clone()
                .or_else(|| Some("docker-compose".to_string())),
            health_status: metadata.health_status.clone(),
            health_detail: metadata.health_detail.clone(),
            last_health_check_at: metadata.last_health_check_at.clone(),
        })
    } else {
        None
    };

    ServiceDiagnosis {
        summary,
        likely_causes,
        suggestions,
        stderr_excerpt: stderr_excerpt.map(ToOwned::to_owned),
        stdout_excerpt: stdout_excerpt.map(ToOwned::to_owned),
        health_status: metadata.health_status.clone(),
        health_detail: metadata.health_detail.clone(),
        suggested_metadata,
    }
}

fn start_disposition(service: Option<&launchctl::LoadedService>) -> &'static str {
    match service {
        Some(service) if service.pid.is_some() => "running",
        Some(_) => "loaded",
        None => "unloaded",
    }
}

#[tauri::command]
pub async fn start_job(plist_path: String) -> Result<(), AppError> {
    let agent = crate::user_agent::load(&plist_path, None)?;
    let loaded = launchctl::list_loaded()?;
    let disposition = start_disposition(loaded.iter().find(|s| s.label == agent.config.label));
    agent.ensure_current()?;
    match disposition {
        "running" => Ok(()),
        "loaded" => launchctl::start_loaded(&agent.config.label),
        _ => launchctl::bootstrap(&agent.path()),
    }
}

#[tauri::command]
pub async fn stop_job(plist_path: String) -> Result<(), AppError> {
    let agent = crate::user_agent::load(&plist_path, None)?;
    agent.ensure_current()?;
    launchctl::bootout(&agent.path())
}

#[tauri::command]
pub async fn restart_job(plist_path: String) -> Result<(), AppError> {
    let agent = crate::user_agent::load(&plist_path, None)?;
    agent.ensure_current()?;
    launchctl::bootout(&agent.path())?;
    agent.ensure_current()?;
    launchctl::bootstrap(&agent.path())
}

#[tauri::command]
pub async fn kickstart_job(label: String, plist_path: String) -> Result<(), AppError> {
    let agent = crate::user_agent::load(&plist_path, Some(&label))?;
    let loaded = launchctl::list_loaded()?;
    agent.ensure_current()?;
    if !loaded.iter().any(|s| s.label == label) {
        launchctl::bootstrap(&agent.path())?;
    }
    agent.ensure_current()?;
    launchctl::kickstart(&label)
}

#[tauri::command]
pub async fn enable_job(label: String, plist_path: String) -> Result<(), AppError> {
    let agent = crate::user_agent::load(&plist_path, Some(&label))?;
    agent.ensure_current()?;
    launchctl::enable(&label)
}

#[tauri::command]
pub async fn disable_job(label: String, plist_path: String) -> Result<(), AppError> {
    let agent = crate::user_agent::load(&plist_path, Some(&label))?;
    agent.ensure_current()?;
    launchctl::disable(&label)
}

/// Save an existing user agent without allowing the caller to change its identity.
#[tauri::command]
pub async fn save_job(plist_path: String, config: PlistConfig) -> Result<(), AppError> {
    let agent = crate::user_agent::load(&plist_path, Some(&config.label))?;
    crate::user_agent::validate_log_parents(&config)?;
    plist_util::validate_config(&config)?;
    service_overlays::transact_plist(
        &agent.path(),
        &config.label,
        Some(&plist_util::serialize_plist(&config)?),
        Some(&config.metadata),
        false,
        Some(&agent),
    )
}

/// Create a new user agent with a single safe label and exclusive file creation.
#[tauri::command]
pub async fn create_job(label: String, config: PlistConfig) -> Result<String, AppError> {
    crate::user_agent::validate_label(&label)?;
    if config.label != label {
        return Err(AppError::Plist(
            "Request and plist labels must match.".into(),
        ));
    }
    crate::user_agent::validate_log_parents(&config)?;
    let bytes = plist_util::serialize_plist(&config)?;
    plist_util::validate_config(&config)?;
    let path_str = plist_util::get_user_agents_dir()
        .join(format!("{label}.plist"))
        .to_string_lossy()
        .into_owned();
    service_overlays::transact_plist(
        &path_str,
        &label,
        Some(&bytes),
        Some(&config.metadata),
        true,
        None,
    )?;
    Ok(path_str)
}

/// Save raw XML only when it retains the validated user agent's existing label.
#[tauri::command]
pub async fn save_raw_plist(plist_path: String, xml: String) -> Result<(), AppError> {
    let agent = crate::user_agent::load(&plist_path, None)?;
    crate::user_agent::validate_xml_label(&xml, &agent.config.label)?;
    plist_util::validate_raw_schedule(xml.as_bytes())?;
    let config = plist_util::parse_plist_bytes(xml.as_bytes())?;
    crate::user_agent::validate_log_parents(&config)?;
    plist_util::validate_config(&config)?;
    service_overlays::transact_plist(
        &agent.path(),
        &config.label,
        Some(xml.as_bytes()),
        Some(&config.metadata),
        false,
        Some(&agent),
    )
}

/// Delete only a validated user agent whose request label matches its plist.
#[tauri::command]
pub async fn delete_job(plist_path: String, label: String) -> Result<(), AppError> {
    let agent = crate::user_agent::load(&plist_path, Some(&label))?;
    let loaded = launchctl::list_loaded()?;
    if loaded.iter().any(|service| service.label == label) {
        agent.ensure_current()?;
        launchctl::bootout(&agent.path())?;
    }
    service_overlays::transact_plist(&agent.path(), &label, None, None, false, Some(&agent))
        .map_err(|error| AppError::Plist(format!("Deletion failed: {error}. Files are recovered or recovery is pending; a previously loaded service may remain stopped.")))
}

#[derive(serde::Serialize)]
pub struct HealthCheckResult {
    status: String,
    detail: String,
    checked_at: String,
}

#[tauri::command]
pub async fn check_service_health(plist_path: String) -> Result<HealthCheckResult, AppError> {
    let (source, checked) = listed_plist(&plist_path)?;
    let job = detail_for_plist(source, &checked)?;
    let (checked, status, detail) = tauri::async_runtime::spawn_blocking(move || {
        let (status, detail) = probe_checked_health(&checked, &job)?;
        Ok::<_, AppError>((checked, status, detail))
    })
    .await
    .map_err(|_| AppError::AgentRuntime("Health probe worker failed.".into()))??;
    let checked_at = current_epoch_millis();
    checked.ensure_current()?;
    service_overlays::record_health(&checked.path(), &status, &detail, &checked_at)?;
    Ok(HealthCheckResult {
        status,
        detail,
        checked_at,
    })
}

#[tauri::command]
pub async fn diagnose_service(plist_path: String) -> Result<ServiceDiagnosis, AppError> {
    let (source, checked) = listed_plist(&plist_path)?;
    let job = detail_for_plist(source, &checked)?;
    let stderr_excerpt = diagnosis_excerpt(
        &checked,
        checked.config().standard_error_path.as_deref(),
        40,
    )?;
    let stdout_excerpt =
        diagnosis_excerpt(&checked, checked.config().standard_out_path.as_deref(), 20)?;
    let mut diagnosis = suggest_repair(&job, stderr_excerpt.as_deref(), stdout_excerpt.as_deref());

    if diagnosis.health_status.is_none() {
        diagnosis.health_status = job.plist.metadata.health_status.clone();
    }
    if diagnosis.health_detail.is_none() {
        diagnosis.health_detail = job.plist.metadata.health_detail.clone();
    }

    Ok(diagnosis)
}

#[derive(serde::Serialize)]
pub struct LogFileResult {
    content: String,
    modified_at: Option<String>,
}

/// Read only a log declared by a listed, contained, descriptor-pinned owning plist.
#[tauri::command]
pub async fn read_log_file(
    path: String,
    plist_path: String,
    tail_lines: Option<usize>,
) -> Result<LogFileResult, AppError> {
    let (_, checked) = listed_plist(&plist_path)?;
    let (content, modified_at) = read_checked_log(&checked, &path, tail_lines.unwrap_or(200))?;
    Ok(LogFileResult {
        content,
        modified_at,
    })
}

/// Clear only a non-symlink log declared by a validated user-agent plist.
#[tauri::command]
pub async fn clear_log_file(path: String, plist_path: String) -> Result<(), AppError> {
    let agent = crate::user_agent::load(&plist_path, None)?;
    agent.ensure_current()?;
    clear_declared_log(&path, &agent.config)
}

fn clear_declared_log(path: &str, config: &PlistConfig) -> Result<(), AppError> {
    let file = crate::user_agent::open_log_for_clear(path, config)?;
    file.set_len(0)?;
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
pub async fn get_app_preferences() -> Result<agent_runtime::AppPreferences, AppError> {
    agent_runtime::load_app_preferences()
}

#[tauri::command]
pub async fn save_app_preferences(
    preferences: agent_runtime::AppPreferences,
) -> Result<agent_runtime::AppPreferences, AppError> {
    agent_runtime::save_app_preferences(&preferences)?;
    Ok(preferences)
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
    crate::user_agent::load(&request.plist_path, Some(&request.label))?;

    let action = classify_command_proposal(&request.command_proposal)?;
    validate_execution_policy(&action, request.auto_apply)?;
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

    fn read_boundary_fixture(root: &std::path::Path, label: &str, extra: &str) -> String {
        let path = root.join(format!("{label}.plist"));
        std::fs::write(
            &path,
            format!("<plist><dict><key>Label</key><string>{label}</string>{extra}</dict></plist>"),
        )
        .unwrap();
        path.to_string_lossy().into_owned()
    }

    #[test]
    fn all_four_read_ipcs_accept_a_catalog_listed_user_fixture() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().canonicalize().unwrap();
        let catalog = directory.join("LaunchAgents");
        let state = directory.join("state");
        std::fs::create_dir(&catalog).unwrap();
        std::fs::create_dir(&state).unwrap();
        std::fs::write(state.join("service-overrides.json"), "{}").unwrap();
        let log = directory.join("job.log");
        std::fs::write(&log, "fixture diagnostic log").unwrap();
        let path = read_boundary_fixture(
            &catalog,
            "com.example.ipc-fixture",
            &format!(
                "<key>StandardErrorPath</key><string>{}</string>",
                log.display()
            ),
        );
        crate::test_support::with_paths(catalog, state.clone(), || {
            tauri::async_runtime::block_on(async {
                let detail = get_job_detail(path.clone()).await.unwrap();
                assert_eq!(detail.label, "com.example.ipc-fixture");
                assert!(matches!(detail.source, JobSource::UserAgent));
                assert_eq!(detail.plist_path, path);
                let health = check_service_health(path.clone()).await.unwrap();
                assert_eq!(health.status, "unknown");
                let diagnosis = diagnose_service(path.clone()).await.unwrap();
                assert_eq!(diagnosis.health_status.as_deref(), Some("unknown"));
                assert_eq!(
                    diagnosis.stderr_excerpt.as_deref(),
                    Some("fixture diagnostic log")
                );
                let read =
                    read_log_file(log.to_string_lossy().into_owned(), path.clone(), Some(20))
                        .await
                        .unwrap();
                assert_eq!(read.content, "fixture diagnostic log");
            });
        });
        let saved: serde_json::Value =
            serde_json::from_slice(&std::fs::read(state.join("service-overrides.json")).unwrap())
                .unwrap();
        assert_eq!(saved[&path]["health_status"], "unknown");
        assert!(crate::test_support::paths().is_none());
    }

    #[test]
    fn detail_membership_also_requires_mutation_grade_containment_and_labels() {
        use std::os::unix::fs::symlink;
        let base = tempfile::tempdir().unwrap();
        let root = base.path().join("LaunchAgents");
        std::fs::create_dir(&root).unwrap();
        let path = read_boundary_fixture(&root, "safe", "");
        let listed = vec![(path.clone(), JobSource::UserAgent)];
        assert!(listed_plist_in(&path, &[], &root).is_err());
        let (_, checked) = listed_plist_in(&path, &listed, &root).unwrap();
        assert_eq!(checked.config().label, "safe");
        let outside = read_boundary_fixture(base.path(), "outside", "");
        for bad in [
            outside.clone(),
            format!("{}/../outside.plist", root.display()),
        ] {
            assert!(listed_plist_in(&bad, &[(bad.clone(), JobSource::UserAgent)], &root).is_err());
        }
        let linked = root.join("linked.plist").to_string_lossy().into_owned();
        symlink(&outside, &linked).unwrap();
        assert!(
            listed_plist_in(&linked, &[(linked.clone(), JobSource::UserAgent)], &root).is_err()
        );
        std::fs::write(
            &path,
            "<plist><dict><key>Label</key><string>other</string></dict></plist>",
        )
        .unwrap();
        assert!(listed_plist_in(&path, &listed, &root).is_err());
        read_boundary_fixture(&root, "safe", "");
        std::fs::hard_link(&path, base.path().join("hard-link.plist")).unwrap();
        assert!(listed_plist_in(&path, &listed, &root).is_err());
    }

    #[test]
    fn all_three_read_ipcs_reject_unlisted_plists_without_probe_or_log_disclosure() {
        let root = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let secret = root.path().join("not-a-job.log");
        std::fs::write(&secret, "fixture-private-sentinel").unwrap();
        let path = read_boundary_fixture(
            root.path(),
            "unlisted",
            &format!(
                "<key>StandardErrorPath</key><string>{}</string><key>LaunchControl</key><dict><key>HealthCheckURL</key><string>http://{}/health</string></dict>",
                secret.display(),
                listener.local_addr().unwrap()
            ),
        );
        let parsed = plist_util::parse_plist(&path).unwrap();
        assert_eq!(
            parsed.metadata.health_check_url.as_deref(),
            Some(format!("http://{}/health", listener.local_addr().unwrap()).as_str())
        );
        assert_eq!(parsed.standard_error_path.as_deref(), secret.to_str());
        // Use the actual native IPC entry points; rejection precedes state recovery and launchctl reads.
        tauri::async_runtime::block_on(async {
            assert!(get_job_detail(path.clone()).await.is_err());
            assert!(check_service_health(path.clone()).await.is_err());
            let error = diagnose_service(path).await.unwrap_err().to_string();
            assert!(error.contains("listed"));
            assert!(!error.contains("fixture-private-sentinel"));
        });
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn health_rejects_a_replaced_user_identity_before_any_network_probe() {
        let root = tempfile::tempdir().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let path = read_boundary_fixture(root.path(), "safe", "");
        let (_, checked) =
            listed_plist_in(&path, &[(path.clone(), JobSource::UserAgent)], root.path()).unwrap();
        let mut job: LaunchdJob = serde_json::from_value(serde_json::json!({"label":"safe", "plist_path":path, "source":"UserAgent", "status":"Running", "pid":123, "last_exit_code":null, "last_run_at":null, "plist":{"label":"safe", "raw_xml":""}})).unwrap();
        job.plist.metadata.health_check_url =
            Some(format!("http://{}/health", listener.local_addr().unwrap()));
        let replacement = read_boundary_fixture(root.path(), "replacement", "");
        std::fs::rename(replacement, &path).unwrap();
        assert!(probe_checked_health(&checked, &job).is_err());
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn diagnosis_reads_only_the_pinned_owners_declared_log_and_rejects_replacement() {
        let root = tempfile::tempdir().unwrap();
        let declared = root.path().join("declared.log");
        let other = root.path().join("other.log");
        std::fs::write(&declared, "declared fixture log").unwrap();
        std::fs::write(&other, "unrelated fixture log").unwrap();
        let path = read_boundary_fixture(
            root.path(),
            "safe",
            &format!(
                "<key>StandardErrorPath</key><string>{}</string>",
                declared.display()
            ),
        );
        let (_, checked) =
            listed_plist_in(&path, &[(path.clone(), JobSource::UserAgent)], root.path()).unwrap();
        assert_eq!(
            diagnosis_excerpt(&checked, Some(declared.to_str().unwrap()), 40)
                .unwrap()
                .as_deref(),
            Some("declared fixture log")
        );
        assert!(diagnosis_excerpt(&checked, Some(other.to_str().unwrap()), 40).is_err());
        let replacement = read_boundary_fixture(root.path(), "replacement", "");
        std::fs::rename(replacement, &path).unwrap();
        assert!(diagnosis_excerpt(&checked, Some(declared.to_str().unwrap()), 40).is_err());
    }

    #[test]
    fn log_viewer_rejects_unlisted_linked_and_replaced_owners() {
        use std::os::unix::fs::symlink;
        let root = tempfile::tempdir().unwrap();
        let log = root.path().join("declared.log");
        std::fs::write(&log, "fixture-private-log-sentinel").unwrap();
        let path = read_boundary_fixture(
            root.path(),
            "safe",
            &format!(
                "<key>StandardOutPath</key><string>{}</string>",
                log.display()
            ),
        );
        let error = tauri::async_runtime::block_on(read_log_file(
            log.to_string_lossy().into_owned(),
            path.clone(),
            Some(20),
        ))
        .err()
        .expect("unlisted log owner must be rejected")
        .to_string();
        assert!(error.contains("listed"));
        assert!(!error.contains("fixture-private-log-sentinel"));
        let linked = root
            .path()
            .join("linked.plist")
            .to_string_lossy()
            .into_owned();
        symlink(&path, &linked).unwrap();
        assert!(
            listed_plist_in(
                &linked,
                &[(linked.clone(), JobSource::UserAgent)],
                root.path()
            )
            .is_err()
        );
        let (_, checked) =
            listed_plist_in(&path, &[(path.clone(), JobSource::UserAgent)], root.path()).unwrap();
        assert_eq!(
            read_checked_log(&checked, log.to_str().unwrap(), 20)
                .unwrap()
                .0,
            "fixture-private-log-sentinel"
        );
        let replacement = read_boundary_fixture(root.path(), "replacement", "");
        std::fs::rename(replacement, &path).unwrap();
        assert!(read_checked_log(&checked, log.to_str().unwrap(), 20).is_err());
    }

    #[test]
    fn start_distinguishes_loaded_and_running_without_a_stop() {
        let mut service = launchctl::LoadedService {
            label: "safe".into(),
            pid: None,
            last_exit_code: Some(0),
        };
        assert_eq!(start_disposition(None), "unloaded");
        assert_eq!(start_disposition(Some(&service)), "loaded");
        service.pid = Some(123);
        assert_eq!(start_disposition(Some(&service)), "running");
    }

    #[test]
    fn failed_explicit_probe_does_not_contact_a_different_inferred_listener() {
        let configured = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let fallback = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        fallback.set_nonblocking(true).unwrap();
        let url = format!("http://{}/health", configured.local_addr().unwrap());
        let port = fallback.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = configured.accept().unwrap();
            let mut request = [0; 2048];
            let _ = stream.read(&mut request).unwrap();
            std::io::Write::write_all(
                &mut stream,
                b"HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        });
        let config: PlistConfig = serde_json::from_value(serde_json::json!({"label":"safe", "raw_xml":"", "program_arguments":["service", format!("--port={port}")], "metadata":{"health_check_url":url}})).unwrap();
        assert_eq!(
            run_health_check_command("safe", &config, &config.metadata)
                .unwrap()
                .0,
            "unhealthy"
        );
        server.join().unwrap();
        assert_eq!(
            fallback.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn log_reads_require_the_owning_plists_declared_destination() {
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), "log data").unwrap();
        let mut config: PlistConfig =
            serde_json::from_value(serde_json::json!({"label":"safe", "raw_xml":""})).unwrap();
        let path = file.path().to_str().unwrap();
        let owner = unsafe { libc::geteuid() };
        assert!(read_declared_log(&config, path, owner, 10).is_err());
        config.standard_out_path = Some(path.into());
        assert_eq!(
            read_declared_log(&config, path, owner, 10).unwrap().0,
            "log data"
        );
    }

    #[test]
    fn bounded_tail_handles_large_lines_and_invalid_utf8() {
        let directory = tempfile::tempdir().unwrap();
        let fifo = directory.path().join("pipe");
        use std::os::unix::ffi::OsStrExt;
        let name = std::ffi::CString::new(fifo.as_os_str().as_bytes()).unwrap();
        // SAFETY: name is a valid NUL-terminated path in a disposable fixture.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        let owner = unsafe { libc::geteuid() };
        assert!(read_tail(fifo.to_str().unwrap(), owner, 10).is_err());
        let file = tempfile::NamedTempFile::new().unwrap();
        let mut bytes = vec![b'x'; 1024 * 1024];
        bytes.extend_from_slice(b"\nlast\n\xffend\n");
        std::fs::write(file.path(), &bytes).unwrap();
        let (text, _) = read_tail(file.path().to_str().unwrap(), owner, 2).unwrap();
        assert_eq!(text, "last\n\u{fffd}end");
        assert!(
            read_tail(file.path().to_str().unwrap(), owner, 2000)
                .unwrap()
                .0
                .len()
                <= 256 * 1024 + 3
        );
    }

    fn security_test_config() -> PlistConfig {
        serde_json::from_value(serde_json::json!({
            "label": "com.example.security", "raw_xml": "", "metadata": {}
        }))
        .unwrap()
    }

    #[test]
    fn every_job_mutation_rejects_system_targets_before_side_effects() {
        let system = "/Library/LaunchDaemons/com.example.security.plist".to_string();
        let config = security_test_config();
        tauri::async_runtime::block_on(async {
            assert!(start_job(system.clone()).await.is_err());
            assert!(stop_job(system.clone()).await.is_err());
            assert!(restart_job(system.clone()).await.is_err());
            assert!(
                kickstart_job(config.label.clone(), system.clone())
                    .await
                    .is_err()
            );
            assert!(
                enable_job(config.label.clone(), system.clone())
                    .await
                    .is_err()
            );
            assert!(
                disable_job(config.label.clone(), system.clone())
                    .await
                    .is_err()
            );
            assert!(save_job(system.clone(), config.clone()).await.is_err());
            assert!(
                save_raw_plist(system.clone(), "invalid".into())
                    .await
                    .is_err()
            );
            assert!(
                delete_job(system.clone(), config.label.clone())
                    .await
                    .is_err()
            );
            assert!(
                clear_log_file("/tmp/not-a-declared-log".into(), system.clone())
                    .await
                    .is_err()
            );
            assert!(
                apply_approved_agent_action(ApprovedAgentActionRequest {
                    plist_path: system,
                    label: config.label.clone(),
                    command_proposal: "start".into(),
                    auto_apply: true
                })
                .await
                .is_err()
            );
            assert!(
                create_job("../outside".into(), config.clone())
                    .await
                    .is_err()
            );
            assert!(create_job("other".into(), config).await.is_err());
        });
    }

    #[test]
    fn backend_auto_apply_policy_rejects_sensitive_actions_and_shell_chains() {
        for action in [
            ApprovedAgentActionKind::Stop,
            ApprovedAgentActionKind::Restart,
            ApprovedAgentActionKind::Enable,
            ApprovedAgentActionKind::Disable,
        ] {
            assert!(validate_execution_policy(&action, true).is_err());
            assert!(validate_execution_policy(&action, false).is_ok());
        }
        for action in [
            ApprovedAgentActionKind::Start,
            ApprovedAgentActionKind::Kickstart,
        ] {
            assert!(validate_execution_policy(&action, true).is_ok());
        }
        for proposal in [
            "launchctl start job; touch /tmp/other",
            "launchctl kickstart job | sh",
            "launchctl start $(other)",
            "launchctl start job\nlaunchctl disable job",
        ] {
            assert!(classify_command_proposal(proposal).is_err());
        }
    }

    #[test]
    fn clear_log_requires_a_declared_regular_nonlinked_file() {
        let directory = tempfile::tempdir().unwrap();
        let log = directory.path().join("stdout.log");
        let other = directory.path().join("other.log");
        std::fs::write(&log, "log data").unwrap();
        std::fs::write(&other, "preserve").unwrap();
        let mut config = security_test_config();
        config.standard_out_path = Some(log.to_str().unwrap().into());
        assert!(clear_declared_log(other.to_str().unwrap(), &config).is_err());
        let linked = directory.path().join("linked.log");
        std::os::unix::fs::symlink(&other, &linked).unwrap();
        config.standard_error_path = Some(linked.to_str().unwrap().into());
        assert!(clear_declared_log(linked.to_str().unwrap(), &config).is_err());
        assert_eq!(std::fs::read_to_string(&other).unwrap(), "preserve");
        clear_declared_log(log.to_str().unwrap(), &config).unwrap();
        assert_eq!(std::fs::read_to_string(&log).unwrap(), "");
    }

    #[test]
    fn health_check_rejects_shell_commands_without_executing_them() {
        let directory = tempfile::tempdir().unwrap();
        let marker = directory.path().join("command-executed");
        let plist: PlistConfig = serde_json::from_value(serde_json::json!({
            "label": "com.example.health-check",
            "raw_xml": "",
            "metadata": {
                "health_check_command": format!("touch '{}'", marker.display())
            }
        }))
        .unwrap();

        let (status, detail) =
            run_health_check_command(&plist.label, &plist, &plist.metadata).unwrap();

        assert!(
            !marker.exists(),
            "health checks must not execute shell text"
        );
        assert_eq!(status, "unknown");
        assert!(detail.contains("Command-based health checks are disabled"));
    }

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

    #[test]
    fn candidate_health_urls_prefers_program_port_before_metadata_port() {
        let plist = PlistConfig {
            label: "ai.cybergrunt.uptime-kuma".to_string(),
            program: None,
            program_arguments: Some(vec![
                "/opt/homebrew/bin/node".to_string(),
                "/opt/homebrew/lib/node_modules/uptime-kuma/server/server.js".to_string(),
                "--port=3002".to_string(),
            ]),
            run_at_load: None,
            keep_alive: None,
            start_interval: None,
            start_calendar_interval: None,
            standard_out_path: None,
            standard_error_path: None,
            working_directory: None,
            environment_variables: None,
            disabled: None,
            wake_system: None,
            metadata: LaunchControlMetadata {
                ports: vec![3001],
                ..LaunchControlMetadata::default()
            },
            raw_xml: String::new(),
        };
        let metadata = plist.metadata.clone();

        let urls = candidate_health_urls(&plist.label, &plist, &metadata);

        assert_eq!(
            urls.first().map(String::as_str),
            Some("http://127.0.0.1:3002/health")
        );
        assert!(urls.iter().any(|url| url == "http://127.0.0.1:3001/health"));
    }

    #[test]
    fn repair_preserves_explicit_health_destination_and_failed_health_summary() {
        let plist: PlistConfig = serde_json::from_value(serde_json::json!({"label":"uptime-kuma", "raw_xml":"", "program_arguments":["service", "--port=3002"], "metadata":{"health_check_url":"http://127.0.0.1:9999/custom", "health_status":"unhealthy", "health_detail":"HTTP 503"}})).unwrap();
        let mut job = LaunchdJob {
            label: plist.label.clone(),
            plist_path: "unused".into(),
            source: JobSource::UserAgent,
            status: JobStatus::Running,
            pid: Some(1234),
            last_exit_code: None,
            plist,
            last_run_at: None,
        };
        job.plist.metadata.last_health_check_at = Some(current_epoch_millis());
        let diagnosis = suggest_repair(&job, Some("unrelated historical diagnostic"), None);
        assert!(diagnosis.summary.contains("unhealthy"));
        assert!(diagnosis.summary.contains("HTTP 503"));
        assert_eq!(
            diagnosis.suggested_metadata.unwrap().health_check_url,
            job.plist.metadata.health_check_url
        );
        job.label = "ordinary-service".into();
        job.plist.metadata.health_status = Some("unknown".into());
        assert!(
            suggest_repair(&job, Some("unrelated historical diagnostic"), None)
                .summary
                .contains("Health is unknown")
        );
    }

    #[test]
    fn suggest_repair_uses_declared_program_port_for_uptime_kuma() {
        let job = LaunchdJob {
            label: "ai.cybergrunt.uptime-kuma".to_string(),
            plist_path: "/Users/jeffreycruz/Library/LaunchAgents/ai.cybergrunt.uptime-kuma.plist"
                .to_string(),
            source: JobSource::UserAgent,
            status: JobStatus::Running,
            pid: Some(1234),
            last_exit_code: Some(1),
            plist: PlistConfig {
                label: "ai.cybergrunt.uptime-kuma".to_string(),
                program: None,
                program_arguments: Some(vec![
                    "/opt/homebrew/bin/node".to_string(),
                    "/opt/homebrew/lib/node_modules/uptime-kuma/server/server.js".to_string(),
                    "--port=3002".to_string(),
                ]),
                run_at_load: None,
                keep_alive: None,
                start_interval: None,
                start_calendar_interval: None,
                standard_out_path: None,
                standard_error_path: None,
                working_directory: None,
                environment_variables: None,
                disabled: None,
                wake_system: None,
                metadata: LaunchControlMetadata {
                    ports: vec![3001, 9000],
                    ..Default::default()
                },
                raw_xml: String::new(),
            },
            last_run_at: None,
        };

        let diagnosis = suggest_repair(&job, None, None);

        let suggested = diagnosis.suggested_metadata.expect("suggested metadata");
        assert_eq!(
            suggested.health_check_url.as_deref(),
            Some("http://127.0.0.1:3002/")
        );
        assert_eq!(suggested.ports, vec![3001, 9000, 3002]);
        assert!(
            diagnosis
                .likely_causes
                .iter()
                .any(|cause| cause.contains("3002"))
        );
    }

    #[test]
    fn suggest_repair_reports_healthy_when_health_check_succeeds() {
        let job = LaunchdJob {
            label: "ai.cybergrunt.uptime-kuma".to_string(),
            plist_path: "/Users/jeffreycruz/Library/LaunchAgents/ai.cybergrunt.uptime-kuma.plist"
                .to_string(),
            source: JobSource::UserAgent,
            status: JobStatus::Running,
            pid: Some(1234),
            last_exit_code: Some(1),
            plist: PlistConfig {
                label: "ai.cybergrunt.uptime-kuma".to_string(),
                program: None,
                program_arguments: Some(vec![
                    "/opt/homebrew/bin/node".to_string(),
                    "/opt/homebrew/lib/node_modules/uptime-kuma/server/server.js".to_string(),
                    "--port=3002".to_string(),
                ]),
                run_at_load: None,
                keep_alive: None,
                start_interval: None,
                start_calendar_interval: None,
                standard_out_path: None,
                standard_error_path: None,
                working_directory: None,
                environment_variables: None,
                disabled: None,
                wake_system: None,
                metadata: LaunchControlMetadata {
                    health_status: Some("healthy".to_string()),
                    last_health_check_at: Some(current_epoch_millis()),
                    health_detail: Some(
                        "GET http://127.0.0.1:3002/ succeeded: Found. Redirecting to /dashboard"
                            .to_string(),
                    ),
                    ..LaunchControlMetadata::default()
                },
                raw_xml: String::new(),
            },
            last_run_at: None,
        };

        let diagnosis = suggest_repair(&job, None, None);

        assert!(
            diagnosis.summary.starts_with("The service is healthy."),
            "unexpected summary: {}",
            diagnosis.summary
        );
        assert!(
            !diagnosis.summary.contains("likely failing"),
            "unexpected summary: {}",
            diagnosis.summary
        );
    }

    #[test]
    fn suggest_repair_reports_unknown_when_no_explicit_health_check_exists() {
        let job = LaunchdJob {
            label: "com.jeffreycruz.agent-continuity-hooks".to_string(),
            plist_path:
                "/Users/jeffreycruz/Library/LaunchAgents/com.jeffreycruz.agent-continuity-hooks.plist"
                    .to_string(),
            source: JobSource::UserAgent,
            status: JobStatus::Running,
            pid: Some(1967),
            last_exit_code: Some(0),
            plist: PlistConfig {
                label: "com.jeffreycruz.agent-continuity-hooks".to_string(),
                program: None,
                program_arguments: Some(vec![
                    "/bin/bash".to_string(),
                    "/Users/jeffreycruz/Development/AI_TOOLS/agent-continuity-hooks/scripts/watch-context.sh".to_string(),
                ]),
                run_at_load: Some(true),
                keep_alive: Some(true),
                start_interval: None,
                start_calendar_interval: None,
                standard_out_path: None,
                standard_error_path: None,
                working_directory: Some(
                    "/Users/jeffreycruz/Development/AI_TOOLS/agent-continuity-hooks".to_string(),
                ),
                environment_variables: None,
                disabled: None,
                wake_system: None,
                metadata: LaunchControlMetadata::default(),
                raw_xml: String::new(),
            },
            last_run_at: None,
        };

        let diagnosis = suggest_repair(&job, None, None);

        assert!(
            diagnosis.summary.contains("unknown"),
            "unexpected summary: {}",
            diagnosis.summary
        );
        assert!(
            !diagnosis.summary.contains("unhealthy"),
            "unexpected summary: {}",
            diagnosis.summary
        );
    }

    #[test]
    fn suggest_repair_keeps_nonzero_exit_despite_historical_gateway_markers() {
        let job = LaunchdJob {
            label: "ai.hermes.gateway".to_string(),
            plist_path: "/Users/jeffreycruz/Library/LaunchAgents/ai.hermes.gateway.plist"
                .to_string(),
            source: JobSource::UserAgent,
            status: JobStatus::Running,
            pid: Some(77462),
            last_exit_code: Some(1),
            plist: PlistConfig {
                label: "ai.hermes.gateway".to_string(),
                program: Some(
                    "/Users/jeffreycruz/.hermes/bin/hermes-gateway-keychain-wrapper.zsh"
                        .to_string(),
                ),
                program_arguments: Some(vec![
                    "/Users/jeffreycruz/.hermes/bin/hermes-gateway-keychain-wrapper.zsh"
                        .to_string(),
                ]),
                run_at_load: Some(true),
                keep_alive: Some(true),
                start_interval: None,
                start_calendar_interval: None,
                standard_out_path: Some("/Users/jeffreycruz/.hermes/logs/gateway.log".to_string()),
                standard_error_path: Some(
                    "/Users/jeffreycruz/.hermes/logs/gateway.error.log".to_string(),
                ),
                working_directory: Some("/Users/jeffreycruz/.hermes".to_string()),
                environment_variables: None,
                disabled: None,
                wake_system: None,
                metadata: LaunchControlMetadata::default(),
                raw_xml: String::new(),
            },
            last_run_at: None,
        };

        let stdout_excerpt = r#"
2026-06-13 20:55:41,115 INFO gateway.run: ✓ telegram connected
2026-06-13 20:55:41,304 INFO gateway.run: ✓ api_server connected
2026-06-13 20:55:41,312 INFO gateway.run: Gateway running with 2 platform(s)
"#;
        let stderr_excerpt = r#"
telegram.error.BadRequest: Chat not found
WARNING tools.mcp_tool: MCP server 'redmine' failed initial connection after 3 attempts, giving up
"#;

        let diagnosis = suggest_repair(&job, Some(stderr_excerpt), Some(stdout_excerpt));

        assert_eq!(diagnosis.health_status.as_deref(), Some("unhealthy"));
        assert!(diagnosis.summary.contains("nonzero"));
        assert!(!diagnosis.likely_causes.is_empty());
    }

    #[test]
    fn suggest_repair_retains_authoritative_failure_without_log_timestamps() {
        let job = LaunchdJob {
            label: "ai.example.service".to_string(),
            plist_path: "/Users/jeffreycruz/Library/LaunchAgents/ai.example.service.plist"
                .to_string(),
            source: JobSource::UserAgent,
            status: JobStatus::Running,
            pid: Some(9021),
            last_exit_code: Some(1),
            plist: PlistConfig {
                label: "ai.example.service".to_string(),
                program: None,
                program_arguments: Some(vec![
                    "/bin/bash".to_string(),
                    "/tmp/service.sh".to_string(),
                ]),
                run_at_load: Some(true),
                keep_alive: Some(true),
                start_interval: None,
                start_calendar_interval: None,
                standard_out_path: Some("/tmp/service.out.log".to_string()),
                standard_error_path: Some("/tmp/service.err.log".to_string()),
                working_directory: Some("/tmp".to_string()),
                environment_variables: None,
                disabled: None,
                wake_system: None,
                metadata: LaunchControlMetadata::default(),
                raw_xml: String::new(),
            },
            last_run_at: None,
        };

        let stderr_excerpt = r#"Traceback (most recent call last):
  File "/tmp/service.sh", line 1, in <module>
    raise RuntimeError("boom")
RuntimeError: boom
"#;

        let diagnosis = suggest_repair(&job, Some(stderr_excerpt), None);

        assert_eq!(diagnosis.health_status.as_deref(), Some("unhealthy"));
        assert!(diagnosis.summary.contains("nonzero"));
        assert!(!diagnosis.likely_causes.is_empty());
    }
    fn cfg(program: Option<&str>, args: Option<Vec<&str>>) -> PlistConfig {
        PlistConfig {
            label: "test".to_string(),
            program: program.map(String::from),
            program_arguments: args.map(|a| a.into_iter().map(String::from).collect()),
            run_at_load: None,
            keep_alive: None,
            start_interval: None,
            start_calendar_interval: None,
            standard_out_path: None,
            standard_error_path: None,
            working_directory: None,
            environment_variables: None,
            disabled: None,
            wake_system: None,
            metadata: LaunchControlMetadata::default(),
            raw_xml: String::new(),
        }
    }

    #[test]
    fn test_is_app_path() {
        assert!(is_app_path(
            "/Applications/Mailspring.app/Contents/MacOS/Mailspring"
        ));
        assert!(is_app_path(
            "/Users/x/Library/Application Support/Google/GoogleUpdater/Current/GoogleUpdater.app/Contents/MacOS/GoogleUpdater"
        ));
        assert!(!is_app_path("/bin/bash"));
        assert!(!is_app_path("/Users/x/instagent-launcher.sh"));
    }

    #[test]
    fn test_references_home_path() {
        let home = "/Users/x";
        assert!(references_home_path("/Users/x/instagent-launcher.sh", home));
        // Home path embedded inside a `zsh -c` command string.
        assert!(references_home_path(
            "cd \"/Users/x/ClaudeCoding/vimeo\" && python3 refresh.py",
            home
        ));
        // Only a vendor app path under home -> not a user script.
        assert!(!references_home_path(
            "/Users/x/Library/Application Support/Google/GoogleUpdater.app/foo",
            home
        ));
        assert!(!references_home_path("/bin/bash", home));
        assert!(!references_home_path(
            "/Users/xyz-other/script.sh",
            "/Users/xyz"
        ));
    }

    #[test]
    fn test_is_home_agent_classification() {
        let home = dirs::home_dir().unwrap().to_string_lossy().into_owned();

        // instagent-style: interpreter running a home script.
        let launcher = format!("{home}/instagent-launcher.sh");
        let instagent = cfg(None, Some(vec!["/bin/bash", &launcher]));
        assert!(is_home_agent(&JobSource::UserAgent, &instagent));

        // vimeo-style: zsh -c with the home path inside the command string.
        let command = format!("cd \"{home}/ClaudeCoding/vimeo\" && python3 refresh.py");
        let vimeo = cfg(None, Some(vec!["/bin/zsh", "-l", "-c", &command]));
        assert!(is_home_agent(&JobSource::UserAgent, &vimeo));

        let mut relative = cfg(None, Some(vec!["/usr/bin/python3", "task.py"]));
        relative.working_directory = Some(format!("{home}/automation"));
        assert!(is_home_agent(&JobSource::UserAgent, &relative));
        for command in ["~/bin/task.sh", "$HOME/bin/task.sh", "${HOME}/bin/task.sh"] {
            assert!(is_home_agent(
                &JobSource::UserAgent,
                &cfg(None, Some(vec!["/bin/zsh", "-c", command]))
            ));
        }

        // Vendor app in /Applications -> not a home agent.
        let mailspring = cfg(
            None,
            Some(vec![
                "/Applications/Mailspring.app/Contents/MacOS/Mailspring",
            ]),
        );
        assert!(!is_home_agent(&JobSource::UserAgent, &mailspring));

        // Vendor auto-updater under ~/Library/Application Support -> not a home agent.
        let updater = format!(
            "{home}/Library/Application Support/Google/GoogleUpdater.app/Contents/MacOS/GoogleUpdater"
        );
        let google = cfg(Some(&updater), None);
        assert!(!is_home_agent(&JobSource::UserAgent, &google));

        // Home script but classified as a system agent -> excluded (Home is a User subset).
        assert!(!is_home_agent(&JobSource::SystemAgent, &instagent));
    }
}
