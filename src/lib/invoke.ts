import { invoke } from "@tauri-apps/api/core"
import type {
  AppPreferences,
  AgentPromptRequest,
  AgentRuntimeResult,
  AgentRuntimeSettings,
  AgentRuntimeSummary,
  ApprovedAgentActionRequest,
  ApprovedAgentActionResult,
  JobListEntry,
  LaunchdJob,
  PlistConfig,
  ServiceDiagnosis,
  ServiceHealthCheckResult,
} from "@/types"

export const listJobs = () => invoke<JobListEntry[]>("list_jobs")

export const getJobDetail = (plistPath: string) =>
  invoke<LaunchdJob>("get_job_detail", { plistPath })

export const startJob = (plistPath: string) =>
  invoke<void>("start_job", { plistPath })

export const stopJob = (plistPath: string) =>
  invoke<void>("stop_job", { plistPath })

export const restartJob = (plistPath: string) =>
  invoke<void>("restart_job", { plistPath })

export const kickstartJob = (label: string, plistPath: string) =>
  invoke<void>("kickstart_job", { label, plistPath })

export const enableJob = (label: string, plistPath: string) =>
  invoke<void>("enable_job", { label, plistPath })

export const disableJob = (label: string, plistPath: string) =>
  invoke<void>("disable_job", { label, plistPath })

export const saveJob = (plistPath: string, config: PlistConfig) =>
  invoke<void>("save_job", { plistPath, config })

export const createJob = (label: string, config: PlistConfig) =>
  invoke<string>("create_job", { label, config })

export const deleteJob = (plistPath: string, label: string) =>
  invoke<void>("delete_job", { plistPath, label })

export type LogFileResult = {
  content: string
  modified_at: string | null
}

export const readLogFile = (path: string, plistPath: string, tailLines?: number) =>
  invoke<LogFileResult>("read_log_file", { path, plistPath, tailLines })

/** Clear a log only after the backend binds it to its mutable user-agent plist. */
export const clearLogFile = (path: string, plistPath: string) =>
  invoke<void>("clear_log_file", { path, plistPath })

export const openLogInEditor = (path: string) =>
  invoke<void>("open_log_in_editor", { path })

export const getHomeDir = () => invoke<string>("get_home_dir")

export const revealInFinder = (path: string) =>
  invoke<void>("reveal_in_finder", { path })

export const getAgentRuntimeSettings = () =>
  invoke<AgentRuntimeSettings>("get_agent_runtime_settings")

export const saveAgentRuntimeSettings = (settings: AgentRuntimeSettings) =>
  invoke<AgentRuntimeSettings>("save_agent_runtime_settings", { settings })

export const getAgentRuntimeSummary = () =>
  invoke<AgentRuntimeSummary>("get_agent_runtime_summary")

export const runAgentPrompt = (request: AgentPromptRequest) =>
  invoke<AgentRuntimeResult>("run_agent_prompt", { request })

export const applyApprovedAgentAction = (request: ApprovedAgentActionRequest) =>
  invoke<ApprovedAgentActionResult>("apply_approved_agent_action", { request })

export const checkServiceHealth = (plistPath: string) =>
  invoke<ServiceHealthCheckResult>("check_service_health", { plistPath })

export const diagnoseService = (plistPath: string) =>
  invoke<ServiceDiagnosis>("diagnose_service", { plistPath })

export const getAppPreferences = () =>
  invoke<AppPreferences>("get_app_preferences")

export const saveAppPreferences = (preferences: AppPreferences) =>
  invoke<AppPreferences>("save_app_preferences", { preferences })

/** Exit after pending preferences have been durably saved or explicitly discarded. */
export async function finishQuit(): Promise<void> { await invoke("finish_quit") }
