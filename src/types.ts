export type JobSource = "UserAgent" | "SystemAgent" | "SystemDaemon"
export type JobStatus = "Running" | "Loaded" | "Unloaded" | "Unknown"

export type JobSortKey = "group" | "label" | "source" | "status" | "pid" | "last_run_at" | "health"
export type SortDirection = "asc" | "desc"

export type JobListEntry = {
  label: string
  pid: number | null
  last_exit_code: number | null
  plist_path: string
  source: JobSource
  status: JobStatus
  last_run_at: string | null
  metadata: LaunchControlMetadata
  log_paths: LogPaths
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
  metadata: LaunchControlMetadata
  raw_xml: string
}

export type LaunchControlMetadata = {
  group: string | null
  tags: string[]
  managed_by: string | null
  description: string | null
  environment: string | null
  health_check_url: string | null
  health_check_command: string | null
  ports: number[]
  template: string | null
  migration_hint: string | null
  health_status: string | null
  health_detail: string | null
  last_health_check_at: string | null
}

export type LogPaths = {
  stdout: string | null
  stderr: string | null
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

export type ServiceRepairSuggestion = {
  title: string
  detail: string
  kind: string
}

export type ServiceDiagnosis = {
  summary: string
  likely_causes: string[]
  suggestions: ServiceRepairSuggestion[]
  stderr_excerpt: string | null
  stdout_excerpt: string | null
  health_status: string | null
  health_detail: string | null
  suggested_metadata: LaunchControlMetadata | null
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
  auto_apply: boolean
}

export type ApprovedAgentActionResult = {
  action: ApprovedAgentActionKind
  command: string
  verified_status: JobStatus
  verified_pid: number | null
  verified_last_exit_code: number | null
}

export type ServiceHealthCheckResult = {
  status: string
  detail: string
  checked_at: string
}

export type AgentPromptRequest = {
  prompt: string
  job_context: string | null
  mode: string
}

export type AppPreferences = {
  search: string
  source_filter: JobSource | "All"
  group_filter: string
  sort_key: JobSortKey
  sort_direction: SortDirection
  agent_mode: "copilot" | "approval" | "assistant"
  detail_open: boolean
  form_open: boolean
  selected_plist_path: string | null
  job_form_draft: JobFormDraft | null
  window_geometry: WindowGeometry | null
}

export type JobFormScheduleType = "none" | "interval" | "calendar"
export type JobFormHourMode = "specific" | "every" | "range"

export type JobFormDraft = {
  sensitive_fields_omitted?: boolean
  editing_plist_path: string | null
  config: PlistConfig
  args: string
  schedule_type: JobFormScheduleType
  hour_mode: JobFormHourMode
  calendar_interval: CalendarInterval | null
  hour_range: {
    from: number
    to: number
  }
}

export type WindowGeometry = {
  x: number
  y: number
  width: number
  height: number
}
