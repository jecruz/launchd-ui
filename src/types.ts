export type JobSource = "UserAgent" | "SystemAgent" | "SystemDaemon"
export type JobStatus = "Running" | "Loaded" | "Unloaded" | "Unknown"

export type JobListEntry = {
  label: string
  pid: number | null
  last_exit_code: number | null
  plist_path: string
  source: JobSource
  status: JobStatus
  last_run_at: string | null
}

export type CalendarInterval = {
  minute: number | null
  hour: number | null
  day: number | null
  weekday: number | null
  month: number | null
}

export type PlistConfig = {
  label: string
  program: string | null
  program_arguments: string[] | null
  run_at_load: boolean | null
  keep_alive: boolean | null
  start_interval: number | null
  start_calendar_interval: CalendarInterval[] | null
  standard_out_path: string | null
  standard_error_path: string | null
  working_directory: string | null
  environment_variables: Record<string, string> | null
  disabled: boolean | null
  wake_system: boolean | null
  raw_xml: string
}

export type LaunchdJob = {
  label: string
  plist_path: string
  source: JobSource
  status: JobStatus
  pid: number | null
  last_exit_code: number | null
  plist: PlistConfig
  last_run_at: string | null
}

export type AgentRuntimeProvider = "LlamaCpp" | "Ollama" | "LocalCli"
export type PromptInputMode = "Stdin" | "Argument"

export type AgentRuntimeSettings = {
  provider: AgentRuntimeProvider
  system_prompt: string
  llama_cpp_executable_path: string
  llama_cpp_model_path: string
  llama_cpp_prompt_flag: string
  llama_cpp_model_flag: string
  llama_cpp_extra_args: string
  ollama_executable_path: string
  ollama_model: string
  ollama_host: string
  local_cli_executable_path: string
  local_cli_args_template: string
  local_cli_prompt_mode: PromptInputMode
  local_cli_prompt_argument: string
}

export type AgentRuntimeSummary = {
  provider: AgentRuntimeProvider
  provider_label: string
  configured: boolean
  details: string[]
  readiness_checks: AgentRuntimeReadinessCheck[]
}

export type AgentRuntimeReadinessCheck = {
  label: string
  status: "ready" | "missing"
  detail: string
}

export type AgentRuntimeResult = {
  response: string
  command_line: string
}

export type ApprovedAgentActionKind =
  | "Start"
  | "Stop"
  | "Restart"
  | "Kickstart"
  | "Enable"
  | "Disable"

export type ApprovedAgentActionRequest = {
  plist_path: string
  label: string
  command_proposal: string
}

export type ApprovedAgentActionResult = {
  action: ApprovedAgentActionKind
  command: string
  verified_status: JobStatus
  verified_pid: number | null
  verified_last_exit_code: number | null
}

export type AgentPromptRequest = {
  prompt: string
  job_context: string | null
  mode: string
}
