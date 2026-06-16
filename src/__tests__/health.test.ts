import { describe, expect, it } from "vitest"
import { deriveHealthText, describeHealth } from "@/lib/health"
import type { LaunchControlMetadata } from "@/types"

describe("health derivation", () => {
  it("shows a running service as Running when there is no explicit health status", () => {
    const metadata: LaunchControlMetadata = {
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
    const job = {
      status: "Running" as const,
      last_exit_code: 0,
      metadata,
    }

    expect(deriveHealthText(job as Parameters<typeof deriveHealthText>[0])).toBe("Running")
    expect(describeHealth(job as Parameters<typeof describeHealth>[0])).toBe("Running")
  })

  it("shows attention for an unhealthy stopped job", () => {
    const metadata: LaunchControlMetadata = {
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
      health_status: "unhealthy",
      health_detail: null,
      last_health_check_at: null,
    }
    const job = {
      status: "Loaded" as const,
      last_exit_code: 1,
      metadata,
    }

    expect(deriveHealthText(job as Parameters<typeof deriveHealthText>[0])).toBe("Attention")
    expect(describeHealth(job as Parameters<typeof describeHealth>[0])).toBe(
      "Attention · Last exit code: 1"
    )
  })

  it("reports no explicit health check when health status is unknown", () => {
    const metadata: LaunchControlMetadata = {
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
      health_status: "unknown",
      health_detail: "No explicit health check configured",
      last_health_check_at: null,
    }
    const job = {
      status: "Running" as const,
      last_exit_code: 0,
      metadata,
    }

    expect(describeHealth(job as Parameters<typeof describeHealth>[0])).toBe(
      "No explicit health check configured"
    )
  })
})
