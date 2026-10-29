import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { JobDetail } from "./JobDetail"
import type { LaunchdJob } from "@/types"
import { resetFakeHandlers, setFakeHandler } from "@/test-utils/tauri-mock"

const baseJob: LaunchdJob = {
  label: "ai.cybergrunt.uptime-kuma",
  plist_path: "/Users/test/Library/LaunchAgents/ai.cybergrunt.uptime-kuma.plist",
  source: "UserAgent",
  status: "Running",
  pid: 1234,
  last_exit_code: 1,
  last_run_at: String(Date.now()),
  plist: {
    label: "ai.cybergrunt.uptime-kuma",
    program: null,
    program_arguments: [
      "/opt/homebrew/bin/node",
      "/opt/homebrew/lib/node_modules/uptime-kuma/server/server.js",
      "--port=3002",
    ],
    run_at_load: true,
    keep_alive: true,
    start_interval: null,
    start_calendar_interval: null,
    standard_out_path: null,
    standard_error_path: null,
    working_directory: null,
    environment_variables: null,
    disabled: null,
    wake_system: null,
    metadata: {
      group: "CAISS System",
      tags: ["uptime-kuma", "monitoring"],
      managed_by: "Daemonic",
      description: "Uptime Kuma service",
      environment: "local",
      health_check_url: "http://127.0.0.1:3001/",
      health_check_command: null,
      ports: [3001],
      template: "web",
      migration_hint: "docker-compose",
      health_status: "unhealthy",
      health_detail: "GET http://127.0.0.1:3001/ failed",
      last_health_check_at: String(Date.now()),
    },
    raw_xml: "",
  },
}

describe("JobDetail", () => {
  afterEach(() => {
    resetFakeHandlers()
  })

  it("refreshes the diagnosis after a successful health check", async () => {
    const user = userEvent.setup()
    const getJobDetail = vi.fn()
    const diagnoseService = vi.fn()

    setFakeHandler("get_job_detail", () => {
      const count = getJobDetail.mock.calls.length
      getJobDetail()
      return {
        ...baseJob,
        last_exit_code: count === 0 ? 1 : 0,
        plist: {
          ...baseJob.plist,
          metadata: {
            ...baseJob.plist.metadata,
            health_status: count === 0 ? "unhealthy" : "healthy",
            health_detail:
              count === 0
                ? "GET http://127.0.0.1:3001/ failed"
                : "Health probe returned HTTP 200 OK.",
            health_check_url: count === 0 ? "http://127.0.0.1:3001/" : "http://127.0.0.1:3002/",
            ports: count === 0 ? [3001] : [3002],
          },
        },
      }
    })

    setFakeHandler("diagnose_service", () => {
      diagnoseService()
      if (diagnoseService.mock.calls.length > 1) return { summary: "The service is healthy. Health probe returned HTTP 200 OK.", likely_causes: [], suggestions: [], stderr_excerpt: null, stdout_excerpt: null, health_status: "healthy", health_detail: "Health probe returned HTTP 200 OK.", suggested_metadata: null }
      return {
        summary: "Uptime Kuma is likely failing because its health/port metadata is incomplete.",
        likely_causes: ["The saved health URL points at the wrong port."],
        suggestions: [],
        stderr_excerpt: null,
        stdout_excerpt: null,
        health_status: "unhealthy",
        health_detail: "GET http://127.0.0.1:3001/ failed",
        suggested_metadata: null,
      }
    })

    setFakeHandler("check_service_health", () => ({
      status: "healthy",
      detail: "Health probe returned HTTP 200 OK.",
      checked_at: String(Date.now()),
    }))

    render(
      <JobDetail
        plistPath={baseJob.plist_path}
        open
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onRepair={vi.fn()}
      />
    )

    await screen.findByText("Uptime Kuma is likely failing because its health/port metadata is incomplete.")
    await user.click(screen.getByRole("button", { name: "Check Health" }))

    await waitFor(() =>
      expect(
        screen.getByText(
          "The service is healthy. Health probe returned HTTP 200 OK."
        )
      ).toBeInTheDocument()
    )
    expect(screen.getByRole("heading", { name: "Health" })).toBeInTheDocument()
    expect(screen.queryByRole("heading", { name: "Repair" })).not.toBeInTheDocument()
  })

  it("shows a health empty state when no explicit health check is configured", async () => {
    const onRepair = vi.fn()
    setFakeHandler("get_job_detail", () => ({
      ...baseJob,
      last_exit_code: 0,
      plist: {
        ...baseJob.plist,
        metadata: {
          ...baseJob.plist.metadata,
          health_status: "unknown",
          health_detail: "No explicit health check configured",
          health_check_url: null,
          health_check_command: null,
        },
      },
    }))

    setFakeHandler("diagnose_service", () => ({
      summary: "The service health is unknown; no explicit health check is configured yet.",
      likely_causes: [],
      suggestions: [],
      stderr_excerpt: null,
      stdout_excerpt: null,
      health_status: "unknown",
      health_detail: "No explicit health check configured",
      suggested_metadata: null,
    }))

    render(
      <JobDetail
        plistPath={baseJob.plist_path}
        open
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onRepair={onRepair}
      />
    )

    expect(await screen.findByRole("heading", { name: "Health" })).toBeInTheDocument()
    expect(screen.getByText("No health check")).toBeInTheDocument()
    expect(screen.getByText("No explicit health check is configured.")).toBeInTheDocument()
    expect(
      screen.getByText("Add a Health Check URL or command to turn this into a probe-backed status.")
    ).toBeInTheDocument()
    expect(
      screen.queryByText("The service health is unknown; no explicit health check is configured yet.")
    ).not.toBeInTheDocument()

    expect(screen.queryByRole("button", { name: "Repair" })).not.toBeInTheDocument()
    expect(onRepair).not.toHaveBeenCalled()
  })

  it("sorts repair causes and suggestions in the detail panel", async () => {
    setFakeHandler("get_job_detail", () => ({
      ...baseJob,
      plist: {
        ...baseJob.plist,
        metadata: {
          ...baseJob.plist.metadata,
          health_status: "unhealthy",
          health_detail: "GET http://127.0.0.1:3001/ failed",
        },
      },
    }))

    setFakeHandler("diagnose_service", () => ({
      summary: "The service is unhealthy.",
      likely_causes: ["Zeta cause", "Alpha cause"],
      suggestions: [
        { title: "Reset plist metadata", detail: "Third option", kind: "plist" },
        { title: "Add service template", detail: "First option", kind: "template" },
        { title: "Add health metadata", detail: "Second option", kind: "metadata" },
      ],
      stderr_excerpt: null,
      stdout_excerpt: null,
      health_status: "unhealthy",
      health_detail: "GET http://127.0.0.1:3001/ failed",
      suggested_metadata: null,
    }))

    render(
      <JobDetail
        plistPath={baseJob.plist_path}
        open
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onRepair={vi.fn()}
      />
    )

    const repairSection = await screen.findByRole("heading", { name: "Repair" })
    const repairContainer = repairSection.closest("section") ?? repairSection.parentElement
    expect(repairContainer).toBeTruthy()

    const likelyCausesSection = within(repairContainer as HTMLElement).getByText("Likely causes")
      .closest("div") as HTMLElement
    expect(within(likelyCausesSection).getAllByRole("listitem")[0]).toHaveTextContent("Alpha cause")
    expect(within(likelyCausesSection).getAllByRole("listitem")[1]).toHaveTextContent("Zeta cause")

    const suggestionsSection = within(repairContainer as HTMLElement).getByText("Suggested fixes")
      .closest("div") as HTMLElement
    const suggestionItems = within(suggestionsSection).getAllByRole("listitem")
    expect(suggestionItems[0]).toHaveTextContent("Add health metadata")
    expect(suggestionItems[1]).toHaveTextContent("Add service template")
    expect(suggestionItems[2]).toHaveTextContent("Reset plist metadata")
  })

  it("copies the label from the detail header", async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText,
      },
    })

    setFakeHandler("get_job_detail", () => ({
      ...baseJob,
      plist: {
        ...baseJob.plist,
        metadata: {
          ...baseJob.plist.metadata,
          health_status: "healthy",
          health_detail: "GET http://127.0.0.1:3002/ succeeded",
          health_check_url: "http://127.0.0.1:3002/",
          ports: [3002],
        },
      },
    }))

    setFakeHandler("diagnose_service", () => ({
      summary: "The service is healthy.",
      likely_causes: [],
      suggestions: [],
      stderr_excerpt: null,
      stdout_excerpt: null,
      health_status: "healthy",
      health_detail: "GET http://127.0.0.1:3002/ succeeded",
      suggested_metadata: null,
    }))

    render(
      <JobDetail
        plistPath={baseJob.plist_path}
        open
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onRepair={vi.fn()}
      />
    )

    await user.click(await screen.findByRole("button", { name: "Copy label ai.cybergrunt.uptime-kuma" }))

    expect(writeText).toHaveBeenCalledWith("ai.cybergrunt.uptime-kuma")
  })
})

it.each(["detail", "diagnosis"])("ignores a stale %s response after selecting another job", async (phase) => {
  let resolveOld!: (value: unknown) => void
  const pending = new Promise((resolve) => { resolveOld = resolve })
  const next = { ...baseJob, label: "com.example.next", plist_path: "/Users/test/Library/LaunchAgents/com.example.next.plist", plist: { ...baseJob.plist, label: "com.example.next" } }
  const diagnosis = (summary: string) => ({ summary, likely_causes: [], suggestions: [], health_status: "healthy", health_detail: null, suggested_metadata: null, stderr_excerpt: null, stdout_excerpt: null })
  const oldStarted = vi.fn()
  setFakeHandler("get_job_detail", ({ plistPath }) => {
    if (plistPath === next.plist_path) return next
    if (phase === "detail") { oldStarted(); return pending }
    return baseJob
  })
  setFakeHandler("diagnose_service", ({ plistPath }) => {
    if (plistPath === next.plist_path) return diagnosis("Current diagnosis")
    oldStarted()
    return pending
  })
  const onEdit = vi.fn()
  const props = { open: true, onClose: vi.fn(), onEdit, onRepair: vi.fn() }
  const view = render(<JobDetail {...props} plistPath={baseJob.plist_path} />)
  await waitFor(() => expect(oldStarted).toHaveBeenCalled())
  view.rerender(<JobDetail {...props} plistPath={next.plist_path} />)
  await screen.findByText("Current diagnosis")
  await act(async () => resolveOld(phase === "detail" ? baseJob : diagnosis("Obsolete diagnosis")))
  expect(screen.getByRole("button", { name: "Copy label com.example.next" })).toBeInTheDocument()
  expect(screen.queryByText("Obsolete diagnosis")).not.toBeInTheDocument()
  await userEvent.setup().click(screen.getByRole("button", { name: "Edit" }))
  expect(onEdit).toHaveBeenCalledWith(next)
  resetFakeHandlers()
})

it("refreshes persisted metadata even when the following health check fails", async () => {
  const getDetail = vi.fn().mockReturnValueOnce(baseJob).mockReturnValue({ ...baseJob, plist: { ...baseJob.plist, metadata: { ...baseJob.plist.metadata, health_check_url: "http://127.0.0.1:3002/" } } })
  setFakeHandler("get_job_detail", getDetail)
  setFakeHandler("diagnose_service", () => ({ summary: "Check metadata", likely_causes: [], suggestions: [], health_status: "unknown", health_detail: null, suggested_metadata: { ...baseJob.plist.metadata, health_check_url: "http://127.0.0.1:3002/" }, stderr_excerpt: null, stdout_excerpt: null }))
  setFakeHandler("save_job", () => undefined)
  setFakeHandler("check_service_health", () => { throw new Error("Unavailable probe") })
  const view = render(<JobDetail plistPath={baseJob.plist_path} open onClose={vi.fn()} onEdit={vi.fn()} onRepair={vi.fn()} />)
  await userEvent.setup().click(await screen.findByRole("button", { name: "Apply Suggested Fix" }))
  await screen.findByText(/Metadata saved; health verification failed/)
  expect(getDetail).toHaveBeenCalledTimes(2)
  expect(screen.getAllByText("http://127.0.0.1:3002/").length).toBeGreaterThan(0)
  view.unmount()
  resetFakeHandlers()
})

it("allows only one suggested-metadata save while verification is pending", async () => {
  const save = vi.fn()
  let finish!: (value: unknown) => void
  setFakeHandler("get_job_detail", () => baseJob)
  setFakeHandler("diagnose_service", () => ({ summary: "Check metadata", likely_causes: [], suggestions: [], health_status: "unknown", health_detail: null, suggested_metadata: baseJob.plist.metadata, stderr_excerpt: null, stdout_excerpt: null }))
  setFakeHandler("save_job", save)
  setFakeHandler("check_service_health", () => new Promise((resolve) => { finish = resolve }))
  const view = render(<JobDetail plistPath={baseJob.plist_path} open onClose={vi.fn()} onEdit={vi.fn()} onRepair={vi.fn()} />)
  const apply = await screen.findByRole("button", { name: "Apply Suggested Fix" })
  await userEvent.setup().click(apply)
  expect(apply).toBeDisabled()
  await userEvent.setup().click(apply)
  expect(save).toHaveBeenCalledTimes(1)
  await act(async () => finish({ status: "unknown", detail: "Unavailable", checked_at: String(Date.now()) }))
  view.unmount()
  resetFakeHandlers()
})

it("reports persisted metadata independently when refreshing saved detail fails", async () => {
  const getDetail = vi.fn().mockReturnValueOnce(baseJob).mockRejectedValue(new Error("Refresh unavailable"))
  setFakeHandler("get_job_detail", getDetail)
  setFakeHandler("diagnose_service", () => ({ summary: "Suggested metadata only", likely_causes: [], suggestions: [], health_status: "unknown", health_detail: null, suggested_metadata: { ...baseJob.plist.metadata, health_check_url: "http://127.0.0.1:3002/" }, stderr_excerpt: null, stdout_excerpt: null }))
  setFakeHandler("save_job", () => undefined)
  setFakeHandler("check_service_health", () => ({ status: "healthy", detail: "HTTP 200", checked_at: String(Date.now()) }))
  const view = render(<JobDetail plistPath={baseJob.plist_path} open onClose={vi.fn()} onEdit={vi.fn()} onRepair={vi.fn()} />)
  await screen.findByRole("heading", { name: "Repair" })
  await userEvent.setup().click(screen.getByRole("button", { name: "Apply Suggested Fix" }))
  await screen.findByText(/Metadata saved; detail refresh failed/)
  expect(screen.getAllByText("http://127.0.0.1:3002/").length).toBeGreaterThan(0)
  view.unmount()
  resetFakeHandlers()
})
