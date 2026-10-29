import type { JobListEntry, LaunchdJob, PlistConfig } from "@/types"
import type { AgentRuntimeSettings } from "@/types"

const defaultPlistConfig: PlistConfig = {
  label: "",
  program: null,
  program_arguments: null,
  run_at_load: null,
  keep_alive: null,
  start_interval: null,
  start_calendar_interval: null,
  standard_out_path: null,
  standard_error_path: null,
  working_directory: null,
  environment_variables: null,
  disabled: null,
  wake_system: null,
  metadata: {
    group: null,
    tags: [],
    managed_by: null,
    description: null,
    environment: null,
    health_check_url: null,
    health_check_command: null,
    ports: [],
    template: null,
    migration_hint: null,
    health_status: null,
    health_detail: null,
    last_health_check_at: null,
  },
  raw_xml: "",
}

const fakeJobs: JobListEntry[] = [
  {
    label: "com.example.running-agent",
    pid: 1234,
    last_exit_code: 0,
    plist_path: "/Users/test/Library/LaunchAgents/com.example.running-agent.plist",
    source: "UserAgent",
    status: "Running",
    last_run_at: String(Date.now()),
    metadata: {
      group: "CAISS System",
      tags: ["caiss", "api"],
      managed_by: "Daemonic",
      description: "CAISS local API service",
      environment: "local",
      health_check_url: "http://127.0.0.1:8001/health",
      health_check_command: null,
      ports: [8001],
      template: "api",
      migration_hint: "docker-compose",
      health_status: "healthy",
      health_detail: "GET http://127.0.0.1:8001/health succeeded",
      last_health_check_at: String(Date.now()),
    },
    log_paths: {
      stdout: "/tmp/my-agent.stdout.log",
      stderr: "/tmp/my-agent.stderr.log",
    },
  },
  {
    label: "com.example.stopped-agent",
    pid: null,
    last_exit_code: 78,
    plist_path: "/Users/test/Library/LaunchAgents/com.example.stopped-agent.plist",
    source: "UserAgent",
    status: "Unloaded",
    last_run_at: null,
    metadata: {
      group: "CAISS System",
      tags: ["caiss", "worker"],
      managed_by: "Daemonic",
      description: "CAISS local worker",
      environment: "local",
      health_check_url: null,
      health_check_command: "pgrep -f worker",
      ports: [],
      template: "worker",
      migration_hint: "docker-compose",
      health_status: "healthy",
      health_detail: "health command succeeded",
      last_health_check_at: String(Date.now()),
    },
    log_paths: {
      stdout: null,
      stderr: "/tmp/stopped-agent.stderr.log",
    },
  },
  {
    label: "com.apple.system-agent",
    pid: 5678,
    last_exit_code: 0,
    plist_path: "/Library/LaunchAgents/com.apple.system-agent.plist",
    source: "SystemAgent",
    status: "Running",
    last_run_at: String(Date.now() - 3600000),
    metadata: {
      group: null,
      tags: [],
      managed_by: null,
      description: null,
      environment: null,
      health_check_url: null,
      health_check_command: null,
      ports: [],
      template: null,
      migration_hint: null,
      health_status: null,
      health_detail: null,
      last_health_check_at: null,
    },
    log_paths: {
      stdout: null,
      stderr: null,
    },
  },
]

const fakeJobDetails: Record<string, LaunchdJob> = {
  "/Users/test/Library/LaunchAgents/com.example.running-agent.plist": {
    label: "com.example.running-agent",
    plist_path: "/Users/test/Library/LaunchAgents/com.example.running-agent.plist",
    source: "UserAgent",
    status: "Running",
    pid: 1234,
    last_exit_code: 0,
    last_run_at: String(Date.now()),
    plist: {
      ...defaultPlistConfig,
      label: "com.example.running-agent",
      program: "/usr/local/bin/my-agent",
      program_arguments: ["/usr/local/bin/my-agent", "--daemon"],
      run_at_load: true,
      keep_alive: true,
      standard_out_path: "/tmp/my-agent.stdout.log",
      standard_error_path: "/tmp/my-agent.stderr.log",
      metadata: {
        group: "CAISS System",
        tags: ["caiss", "api"],
        managed_by: "Daemonic",
        description: "CAISS local API service",
        environment: "local",
        health_check_url: "http://127.0.0.1:8001/health",
        health_check_command: null,
        ports: [8001],
        template: "api",
        migration_hint: "docker-compose",
        health_status: "healthy",
        health_detail: "GET http://127.0.0.1:8001/health succeeded",
        last_health_check_at: String(Date.now()),
      },
      raw_xml: '<?xml version="1.0"?><!DOCTYPE plist><plist version="1.0"><dict></dict></plist>',
    },
  },
}

type CommandHandler = (args: Record<string, unknown>) => unknown

const handlers: Record<string, CommandHandler> = {
  list_jobs: () => [...fakeJobs],
  get_job_detail: (args) => {
    const path = args.plistPath as string
    return fakeJobDetails[path] ?? null
  },
  start_job: () => undefined,
  stop_job: () => undefined,
  restart_job: () => undefined,
  kickstart_job: () => undefined,
  enable_job: () => undefined,
  disable_job: () => undefined,
  save_job: () => undefined,
  create_job: () => "/Users/test/Library/LaunchAgents/new-job.plist",
  delete_job: () => undefined,
  get_home_dir: () => "/Users/test",
  clear_log_file: () => undefined,
  read_log_file: () => ({
    content: "2024-01-01 12:00:00 INFO Started\n2024-01-01 12:00:01 INFO Running\n",
    modified_at: String(Date.now()),
  }),
  open_log_in_editor: () => undefined,
  reveal_in_finder: () => undefined,
  get_agent_runtime_settings: () =>
    ({
      provider: "Ollama",
      system_prompt: "You are Daemonic.",
      llama_cpp_executable_path: "",
      llama_cpp_model_path: "",
      llama_cpp_prompt_flag: "-p",
      llama_cpp_model_flag: "-m",
      llama_cpp_extra_args: "--ctx-size 4096",
      ollama_executable_path: "ollama",
      ollama_model: "llama3.2:1b",
      ollama_host: "http://127.0.0.1:11434",
      local_cli_executable_path: "",
      local_cli_args_template: "",
      local_cli_prompt_mode: "Stdin",
      local_cli_prompt_argument: "--prompt",
    } as AgentRuntimeSettings),
  get_agent_runtime_summary: () => ({
    provider: "Ollama",
    provider_label: "Ollama",
    configured: true,
    details: ["ollama", "model: llama3.2:1b"],
    readiness_checks: [
      { label: "Executable", status: "ready", detail: "ollama" },
      { label: "Model", status: "ready", detail: "llama3.2:1b" },
      { label: "Host", status: "ready", detail: "default local Ollama host" },
    ],
  }),
  save_agent_runtime_settings: (args) => args.settings,
  run_agent_prompt: (args) => ({
    response: `Mock response for ${args.mode}`,
    command_line: "mock-runner --prompt",
  }),
  check_service_health: () => ({
    status: "healthy",
    detail: "health check succeeded",
    checked_at: String(Date.now()),
  }),
  diagnose_service: () => ({
    summary: "The service is healthy.",
    likely_causes: [],
    suggestions: [],
    stderr_excerpt: null,
    stdout_excerpt: null,
    health_status: "healthy",
    health_detail: "health check succeeded",
    suggested_metadata: null,
  }),
  apply_approved_agent_action: () => ({
    action: "Kickstart",
    command: "launchctl kickstart -k gui/501/com.example.test",
    verified_status: "Running",
    verified_pid: 123,
    verified_last_exit_code: 0,
  }),
  get_app_preferences: () => ({
    search: "running",
    source_filter: "UserAgent",
    group_filter: "All",
    sort_key: "label",
    sort_direction: "asc",
    agent_mode: "approval",
    detail_open: false,
    form_open: false,
    selected_plist_path: null,
    job_form_draft: null,
    window_geometry: null,
  }),
  save_app_preferences: (args) => args.preferences,
}

let customHandlers: Record<string, CommandHandler> = {}

export function setFakeHandler(command: string, handler: CommandHandler) {
  customHandlers[command] = handler
}

export function resetFakeHandlers() {
  customHandlers = {}
}

export async function invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const handler = customHandlers[command] ?? handlers[command]
  if (!handler) {
    throw new Error(`Unknown command: ${command}`)
  }
  return handler(args ?? {}) as T
}
