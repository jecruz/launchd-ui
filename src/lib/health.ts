import type { JobListEntry, LaunchdJob } from "@/types"

type HealthSubject = {
  status: JobListEntry["status"]
  last_exit_code: JobListEntry["last_exit_code"]
  metadata?: JobListEntry["metadata"]
  plist?: { metadata: JobListEntry["metadata"] }
}

function hasNonZeroExitCode(lastExitCode: number | null): boolean {
  return lastExitCode !== null && lastExitCode !== undefined && lastExitCode !== 0
}

function getMetadata(job: HealthSubject): JobListEntry["metadata"] {
  return job.metadata ?? job.plist?.metadata ?? {
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
  }
}

function hasExplicitHealthCheck(job: HealthSubject): boolean {
  const metadata = getMetadata(job)
  return Boolean(metadata.health_check_url || metadata.health_check_command)
}

/**
 * Derive the display health text for a launchd job.
 *
 * Running jobs are reported as Running unless the job has explicit health metadata
 * or a non-zero exit code.
 */
export function deriveHealthText(job: HealthSubject): string {
  const metadata = getMetadata(job)
  if (job.last_exit_code !== null && job.last_exit_code !== undefined && job.last_exit_code !== 0) {
    return "Attention"
  }
  if (metadata.health_status === "healthy") {
    return "Healthy"
  }
  if (metadata.health_status === "unhealthy") {
    return "Attention"
  }
  if (job.status === "Running") {
    return "Running"
  }
  if (job.status === "Loaded") {
    return "Loaded"
  }
  return "Idle"
}

/**
 * Build a health line for diagnostic and assistant context.
 */
export function describeHealth(job: LaunchdJob | JobListEntry): string {
  const healthText = deriveHealthText(job)
  const lastExit = hasNonZeroExitCode(job.last_exit_code)
    ? `Last exit code: ${job.last_exit_code}`
    : null
  const noExplicitHealthCheck =
    getMetadata(job).health_status === "unknown" && !hasExplicitHealthCheck(job)

  const healthLine = noExplicitHealthCheck
    ? "No explicit health check configured"
    : healthText

  return [healthLine, lastExit].filter(Boolean).join(" · ")
}
