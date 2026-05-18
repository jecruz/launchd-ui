use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};

const APP_DIR_NAME: &str = "launchd-ui";
const SETTINGS_FILE_NAME: &str = "agent-runtime.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AgentRuntimeProvider {
    LlamaCpp,
    Ollama,
    LocalCli,
}

impl AgentRuntimeProvider {
    pub fn label(&self) -> &'static str {
        match self {
            Self::LlamaCpp => "llama.cpp / yama.cpp",
            Self::Ollama => "Ollama",
            Self::LocalCli => "Custom local CLI",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum PromptInputMode {
    Stdin,
    Argument,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntimeSettings {
    pub provider: AgentRuntimeProvider,
    pub system_prompt: String,
    pub llama_cpp_executable_path: String,
    pub llama_cpp_model_path: String,
    pub llama_cpp_prompt_flag: String,
    pub llama_cpp_model_flag: String,
    pub llama_cpp_extra_args: String,
    pub ollama_executable_path: String,
    pub ollama_model: String,
    pub ollama_host: String,
    pub local_cli_executable_path: String,
    pub local_cli_args_template: String,
    pub local_cli_prompt_mode: PromptInputMode,
    pub local_cli_prompt_argument: String,
}

impl Default for AgentRuntimeSettings {
    fn default() -> Self {
        Self {
            provider: AgentRuntimeProvider::Ollama,
            system_prompt: "You are Launch Control, a macOS launchd expert. Be concise, evidence-based, and do not claim to have executed changes. If an action is needed, propose a safe step and clearly state when approval is required.".to_string(),
            llama_cpp_executable_path: String::new(),
            llama_cpp_model_path: String::new(),
            llama_cpp_prompt_flag: "-p".to_string(),
            llama_cpp_model_flag: "-m".to_string(),
            llama_cpp_extra_args: "--ctx-size 4096 --temp 0.2".to_string(),
            ollama_executable_path: "ollama".to_string(),
            ollama_model: String::new(),
            ollama_host: String::new(),
            local_cli_executable_path: String::new(),
            local_cli_args_template: "--temperature 0.2".to_string(),
            local_cli_prompt_mode: PromptInputMode::Stdin,
            local_cli_prompt_argument: "--prompt".to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntimeSummary {
    pub provider: AgentRuntimeProvider,
    pub provider_label: String,
    pub configured: bool,
    pub details: Vec<String>,
    pub readiness_checks: Vec<AgentRuntimeReadinessCheck>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntimeReadinessCheck {
    pub label: String,
    pub status: String,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentRuntimeResult {
    pub response: String,
    pub command_line: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentPromptRequest {
    pub prompt: String,
    pub job_context: Option<String>,
    pub mode: String,
}

fn app_settings_dir() -> Result<PathBuf, AppError> {
    let dir = dirs::config_dir()
        .ok_or_else(|| AppError::AgentRuntime("could not determine config directory".to_string()))?
        .join(APP_DIR_NAME);
    Ok(dir)
}

fn settings_file() -> Result<PathBuf, AppError> {
    Ok(app_settings_dir()?.join(SETTINGS_FILE_NAME))
}

pub fn load_agent_runtime_settings() -> Result<AgentRuntimeSettings, AppError> {
    let path = settings_file()?;
    match std::fs::read_to_string(&path) {
        Ok(contents) => serde_json::from_str(&contents)
            .map_err(|e| AppError::AgentRuntime(format!("failed to parse {path:?}: {e}"))),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(AgentRuntimeSettings::default()),
        Err(e) => Err(AppError::AgentRuntime(format!(
            "failed to read {path:?}: {e}"
        ))),
    }
}

pub fn save_agent_runtime_settings(settings: &AgentRuntimeSettings) -> Result<(), AppError> {
    let path = settings_file()?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            AppError::AgentRuntime(format!(
                "failed to create settings directory {parent:?}: {e}"
            ))
        })?;
    }
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| AppError::AgentRuntime(format!("failed to serialize settings: {e}")))?;
    std::fs::write(&path, json)
        .map_err(|e| AppError::AgentRuntime(format!("failed to write {path:?}: {e}")))
}

pub fn summarize_settings(settings: &AgentRuntimeSettings) -> AgentRuntimeSummary {
    let mut details = Vec::new();
    let mut readiness_checks = Vec::new();
    let configured = match settings.provider {
        AgentRuntimeProvider::LlamaCpp => {
            if settings.llama_cpp_executable_path.is_empty() {
                details.push("missing executable path".to_string());
                readiness_checks.push(readiness_check(
                    "Executable",
                    false,
                    "Set the llama.cpp or yama.cpp executable path.",
                ));
                false
            } else if settings.llama_cpp_model_path.is_empty() {
                details.push("missing model path".to_string());
                readiness_checks.push(readiness_check(
                    "Executable",
                    true,
                    &settings.llama_cpp_executable_path,
                ));
                readiness_checks.push(readiness_check(
                    "Model",
                    false,
                    "Set a local GGUF model path.",
                ));
                false
            } else {
                details.push(format!(
                    "{} {}",
                    settings.llama_cpp_executable_path, settings.llama_cpp_prompt_flag
                ));
                readiness_checks.push(readiness_check(
                    "Executable",
                    true,
                    &settings.llama_cpp_executable_path,
                ));
                readiness_checks.push(readiness_check(
                    "Model",
                    true,
                    &settings.llama_cpp_model_path,
                ));
                readiness_checks.push(readiness_check(
                    "Prompt flag",
                    true,
                    &settings.llama_cpp_prompt_flag,
                ));
                true
            }
        }
        AgentRuntimeProvider::Ollama => {
            if settings.ollama_executable_path.is_empty() {
                details.push("missing ollama executable".to_string());
                readiness_checks.push(readiness_check(
                    "Executable",
                    false,
                    "Set the ollama executable path.",
                ));
                false
            } else if settings.ollama_model.is_empty() {
                details.push("missing model name".to_string());
                readiness_checks.push(readiness_check(
                    "Executable",
                    true,
                    &settings.ollama_executable_path,
                ));
                readiness_checks.push(readiness_check("Model", false, "Set an Ollama model name."));
                false
            } else {
                details.push(format!(
                    "{} run {}",
                    settings.ollama_executable_path, settings.ollama_model
                ));
                readiness_checks.push(readiness_check(
                    "Executable",
                    true,
                    &settings.ollama_executable_path,
                ));
                readiness_checks.push(readiness_check("Model", true, &settings.ollama_model));
                readiness_checks.push(readiness_check(
                    "Host",
                    true,
                    if settings.ollama_host.is_empty() {
                        "default local Ollama host"
                    } else {
                        &settings.ollama_host
                    },
                ));
                true
            }
        }
        AgentRuntimeProvider::LocalCli => {
            if settings.local_cli_executable_path.is_empty() {
                details.push("missing executable path".to_string());
                readiness_checks.push(readiness_check(
                    "Executable",
                    false,
                    "Set the custom local CLI executable path.",
                ));
                false
            } else if settings.local_cli_args_template.is_empty()
                && matches!(settings.local_cli_prompt_mode, PromptInputMode::Argument)
            {
                details.push("prompt argument mode needs an argument template".to_string());
                readiness_checks.push(readiness_check(
                    "Executable",
                    true,
                    &settings.local_cli_executable_path,
                ));
                readiness_checks.push(readiness_check(
                    "Prompt mode",
                    false,
                    "Argument mode needs an args template containing the prompt.",
                ));
                false
            } else {
                details.push(format!(
                    "{} [{}]",
                    settings.local_cli_executable_path,
                    match settings.local_cli_prompt_mode {
                        PromptInputMode::Stdin => "stdin",
                        PromptInputMode::Argument => "argument",
                    }
                ));
                readiness_checks.push(readiness_check(
                    "Executable",
                    true,
                    &settings.local_cli_executable_path,
                ));
                readiness_checks.push(readiness_check(
                    "Prompt mode",
                    true,
                    match settings.local_cli_prompt_mode {
                        PromptInputMode::Stdin => "stdin",
                        PromptInputMode::Argument => "argument",
                    },
                ));
                true
            }
        }
    };

    AgentRuntimeSummary {
        provider: settings.provider.clone(),
        provider_label: settings.provider.label().to_string(),
        configured,
        details,
        readiness_checks,
    }
}

fn readiness_check(label: &str, ok: bool, detail: &str) -> AgentRuntimeReadinessCheck {
    AgentRuntimeReadinessCheck {
        label: label.to_string(),
        status: if ok { "ready" } else { "missing" }.to_string(),
        detail: detail.to_string(),
    }
}

fn parse_args_template(input: &str) -> Vec<String> {
    let mut result = Vec::new();
    let mut current = String::new();
    let mut in_double = false;
    let mut in_single = false;

    for ch in input.chars() {
        match ch {
            '"' if !in_single => in_double = !in_double,
            '\'' if !in_double => in_single = !in_single,
            ' ' if !in_double && !in_single => {
                if !current.is_empty() {
                    result.push(std::mem::take(&mut current));
                }
            }
            _ => current.push(ch),
        }
    }

    if !current.is_empty() {
        result.push(current);
    }

    result
}

fn render_template(input: &str, prompt: &str, context: &str) -> String {
    input
        .replace("{prompt}", prompt)
        .replace("{context}", context)
}

fn format_context(prompt: &AgentPromptRequest) -> String {
    let mut context = String::new();
    if let Some(job_context) = &prompt.job_context {
        context.push_str("Context:\n");
        context.push_str(job_context);
        context.push_str("\n\n");
    }
    context.push_str("Mode: ");
    context.push_str(&prompt.mode);
    context.push_str("\nUser request:\n");
    context.push_str(&prompt.prompt);
    context
}

fn run_command_with_input(mut command: Command, input: Option<&str>) -> Result<String, AppError> {
    command.stdout(Stdio::piped());
    command.stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    }

    let mut child = command
        .spawn()
        .map_err(|e| AppError::AgentRuntime(format!("failed to spawn command: {e}")))?;

    if let Some(stdin_text) = input {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(stdin_text.as_bytes())
                .map_err(|e| AppError::AgentRuntime(format!("failed to write stdin: {e}")))?;
        }
    }

    let output = child
        .wait_with_output()
        .map_err(|e| AppError::AgentRuntime(format!("failed to wait for command: {e}")))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(AppError::AgentRuntime(if stderr.is_empty() {
            "command exited with a non-zero status".to_string()
        } else {
            stderr
        }));
    }

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Ok(stdout)
}

pub fn run_agent_prompt(
    settings: &AgentRuntimeSettings,
    request: &AgentPromptRequest,
) -> Result<AgentRuntimeResult, AppError> {
    let context = format_context(request);
    let full_prompt = if settings.system_prompt.trim().is_empty() {
        context.clone()
    } else {
        format!("{}\n\n{}", settings.system_prompt.trim(), context)
    };

    match settings.provider {
        AgentRuntimeProvider::LlamaCpp => {
            if settings.llama_cpp_executable_path.is_empty() {
                return Err(AppError::AgentRuntime(
                    "llama.cpp/yama.cpp executable path is required".to_string(),
                ));
            }
            if settings.llama_cpp_model_path.is_empty() {
                return Err(AppError::AgentRuntime(
                    "llama.cpp/yama.cpp model path is required".to_string(),
                ));
            }

            let mut command = Command::new(&settings.llama_cpp_executable_path);
            for arg in parse_args_template(&settings.llama_cpp_extra_args) {
                command.arg(arg);
            }
            if !settings.llama_cpp_model_flag.is_empty() {
                command.arg(&settings.llama_cpp_model_flag);
            }
            command.arg(&settings.llama_cpp_model_path);
            if !settings.llama_cpp_prompt_flag.is_empty() {
                command.arg(&settings.llama_cpp_prompt_flag);
            }
            command.arg(&full_prompt);

            let command_line = format!(
                "{} {} {} {} {}",
                settings.llama_cpp_executable_path,
                settings.llama_cpp_extra_args,
                settings.llama_cpp_model_flag,
                settings.llama_cpp_model_path,
                settings.llama_cpp_prompt_flag
            );
            let response = run_command_with_input(command, None)?;
            Ok(AgentRuntimeResult {
                response,
                command_line,
            })
        }
        AgentRuntimeProvider::Ollama => {
            if settings.ollama_executable_path.is_empty() {
                return Err(AppError::AgentRuntime(
                    "ollama executable path is required".to_string(),
                ));
            }
            if settings.ollama_model.is_empty() {
                return Err(AppError::AgentRuntime(
                    "ollama model name is required".to_string(),
                ));
            }

            let mut command = Command::new(&settings.ollama_executable_path);
            if !settings.ollama_host.trim().is_empty() {
                command.env("OLLAMA_HOST", settings.ollama_host.trim());
            }
            command.arg("run");
            command.arg(&settings.ollama_model);
            command.arg(&full_prompt);

            let command_line = format!(
                "{} run {}",
                settings.ollama_executable_path, settings.ollama_model
            );
            let response = run_command_with_input(command, None)?;
            Ok(AgentRuntimeResult {
                response,
                command_line,
            })
        }
        AgentRuntimeProvider::LocalCli => {
            if settings.local_cli_executable_path.is_empty() {
                return Err(AppError::AgentRuntime(
                    "custom local CLI executable path is required".to_string(),
                ));
            }

            let mut command = Command::new(&settings.local_cli_executable_path);
            let mut command_line = settings.local_cli_executable_path.clone();
            let mut stdin_payload = None;

            let rendered_args =
                render_template(&settings.local_cli_args_template, &full_prompt, &context);

            match settings.local_cli_prompt_mode {
                PromptInputMode::Stdin => {
                    for arg in parse_args_template(&rendered_args) {
                        command.arg(arg);
                    }
                    stdin_payload = Some(full_prompt.as_str());
                    command_line = format!("{} {}", command_line, rendered_args);
                }
                PromptInputMode::Argument => {
                    let args = parse_args_template(&rendered_args);
                    if args.is_empty() {
                        return Err(AppError::AgentRuntime(
                            "prompt argument mode requires at least one argument template"
                                .to_string(),
                        ));
                    }
                    for arg in args {
                        command.arg(arg);
                    }
                    if !settings.local_cli_prompt_argument.is_empty() {
                        command.arg(&settings.local_cli_prompt_argument);
                    }
                    command.arg(&full_prompt);
                    command_line = format!(
                        "{} {} {}",
                        command_line, rendered_args, settings.local_cli_prompt_argument
                    );
                }
            }

            let response = run_command_with_input(command, stdin_payload)?;
            Ok(AgentRuntimeResult {
                response,
                command_line,
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_settings_are_serializable() {
        let settings = AgentRuntimeSettings::default();
        let json = serde_json::to_string(&settings).unwrap();
        assert!(json.contains("system_prompt"));
        assert!(json.contains("\"provider\":\"Ollama\""));
        let parsed: AgentRuntimeSettings = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.provider, AgentRuntimeProvider::Ollama);
    }

    #[test]
    fn template_rendering_replaces_prompt_and_context() {
        let rendered = render_template("prefix {context} :: {prompt}", "hello", "job context");
        assert!(rendered.contains("job context"));
        assert!(rendered.contains("hello"));
    }

    #[test]
    fn arg_parser_handles_quotes() {
        let args = parse_args_template("--foo \"bar baz\" --qux");
        assert_eq!(args, vec!["--foo", "bar baz", "--qux"]);
    }

    #[test]
    fn summary_exposes_structured_readiness_checks() {
        let mut settings = AgentRuntimeSettings::default();
        settings.ollama_executable_path = "ollama".to_string();
        settings.ollama_model = String::new();

        let summary = summarize_settings(&settings);

        assert!(!summary.configured);
        assert_eq!(summary.readiness_checks[0].label, "Executable");
        assert_eq!(summary.readiness_checks[0].status, "ready");
        assert_eq!(summary.readiness_checks[1].label, "Model");
        assert_eq!(summary.readiness_checks[1].status, "missing");
    }
}
