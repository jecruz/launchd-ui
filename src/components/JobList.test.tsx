import { describe, it, expect, vi } from "vitest"
import userEvent from "@testing-library/user-event"
import { render, screen, within } from "@testing-library/react"
import { useState, type ComponentProps } from "react"
import { JobList as JobTable } from "./JobList"

function JobList(props: Partial<ComponentProps<typeof JobTable>> & { jobs: JobListEntry[] }) {
  const [key, setKey] = useState<ComponentProps<typeof JobTable>["sortKey"]>(props.sortKey ?? "health")
  const [direction, setDirection] = useState<ComponentProps<typeof JobTable>["sortDirection"]>(props.sortDirection ?? "asc")
  return <JobTable {...props as ComponentProps<typeof JobTable>} sortKey={key} sortDirection={direction} onSortChange={(key, direction) => { setKey(key); setDirection(direction); props.onSortChange?.(key, direction) }} />
}
import type { JobListEntry } from "@/types"

const mockJobs: JobListEntry[] = [
  {
    label: "com.example.zulu",
    pid: 300,
    last_exit_code: 0,
    plist_path: "/Users/test/Library/LaunchAgents/com.example.zulu.plist",
    source: "UserAgent",
    is_home_agent: true,
    status: "Loaded",
    last_run_at: String(Date.now() - 10_000),
    metadata: {
      group: "CAISS System",
      tags: ["caiss", "api"],
      managed_by: "Daemonic",
      description: "Zulu API",
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
      stdout: "/tmp/zulu.out",
      stderr: "/tmp/zulu.err",
    },
  },
  {
    label: "com.example.alpha",
    pid: null,
    last_exit_code: 78,
    plist_path: "/Users/test/Library/LaunchAgents/com.example.alpha.plist",
    source: "SystemDaemon",
    is_home_agent: false,
    status: "Unloaded",
    last_run_at: null,
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
  {
    label: "com.example.bravo",
    pid: 100,
    last_exit_code: 0,
    plist_path: "/Users/test/Library/LaunchAgents/com.example.bravo.plist",
    source: "SystemAgent",
    is_home_agent: false,
    status: "Running",
    last_run_at: String(Date.now() - 20_000),
    metadata: {
      group: "CAISS System",
      tags: ["caiss", "worker"],
      managed_by: "Daemonic",
      description: "Bravo worker",
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
      stderr: "/tmp/bravo.err",
    },
  },
]

const noop = vi.fn()

function installClipboardMock() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText,
    },
  })
  return writeText
}

function renderJobList(
  props: Partial<ComponentProps<typeof JobList>> = {}
) {
  return render(
    <JobList
      jobs={mockJobs}
      loading={false}
      onStart={noop}
      onStop={noop}
      onRestart={noop}
      onKickstart={noop}
      onEdit={noop}
      onDelete={noop}
      onSelect={noop}
      onRevealInFinder={noop}
      {...props}
    />
  )
}

describe("JobList", () => {
  it("renders loading state", () => {
    renderJobList({ jobs: [], loading: true })
    expect(screen.getByText("Loading agents...")).toBeInTheDocument()
  })

  it("renders empty state", () => {
    renderJobList({ jobs: [] })
    expect(screen.getByText("No agents found")).toBeInTheDocument()
  })

  it("renders job list with labels", () => {
    renderJobList()
    expect(screen.getByText("com.example.alpha")).toBeInTheDocument()
    expect(screen.getByText("com.example.bravo")).toBeInTheDocument()
    expect(screen.getByText("com.example.zulu")).toBeInTheDocument()
  })

  it("renders status badges", () => {
    renderJobList()
    expect(screen.getByText("Running")).toBeInTheDocument()
    expect(screen.getByText("Unloaded")).toBeInTheDocument()
  })

  it("renders PID for running job", () => {
    renderJobList()
    expect(screen.getByText("300")).toBeInTheDocument()
  })

  it("copies the label from the row without selecting the row", async () => {
    const user = userEvent.setup()
    const writeText = installClipboardMock()
    const onSelect = vi.fn()

    renderJobList({ onSelect })

    const copyButton = screen.getByRole("button", { name: "Copy label com.example.alpha" })
    await user.click(copyButton)

    expect(writeText).toHaveBeenCalledWith("com.example.alpha")
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("sorts jobs by column headers", async () => {
    const user = userEvent.setup()

    renderJobList()

    const rows = () => screen.getAllByRole("row")

    expect(within(rows()[1]).getByText("com.example.bravo")).toBeInTheDocument()
    expect(within(rows()[2]).getByText("com.example.zulu")).toBeInTheDocument()
    expect(within(rows()[3]).getByText("com.example.alpha")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /sort by pid/i }))

    expect(within(rows()[1]).getByText("com.example.bravo")).toBeInTheDocument()
    expect(within(rows()[2]).getByText("com.example.zulu")).toBeInTheDocument()
    expect(within(rows()[3]).getByText("com.example.alpha")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /sort by pid/i }))

    expect(within(rows()[1]).getByText("com.example.zulu")).toBeInTheDocument()
    expect(within(rows()[2]).getByText("com.example.bravo")).toBeInTheDocument()
    expect(within(rows()[3]).getByText("com.example.alpha")).toBeInTheDocument()
  })

  it("sorts jobs by health severity", async () => {
    const user = userEvent.setup()

    renderJobList()

    const rows = () => screen.getAllByRole("row")

    expect(within(rows()[1]).getByText("com.example.bravo")).toBeInTheDocument()
    expect(within(rows()[2]).getByText("com.example.zulu")).toBeInTheDocument()
    expect(within(rows()[3]).getByText("com.example.alpha")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /sort by health/i }))

    expect(within(rows()[1]).getByText("com.example.alpha")).toBeInTheDocument()
    expect(within(rows()[2]).getByText("com.example.zulu")).toBeInTheDocument()
    expect(within(rows()[3]).getByText("com.example.bravo")).toBeInTheDocument()

    await user.click(screen.getByRole("button", { name: /sort by health/i }))

    expect(within(rows()[1]).getByText("com.example.bravo")).toBeInTheDocument()
    expect(within(rows()[2]).getByText("com.example.zulu")).toBeInTheDocument()
    expect(within(rows()[3]).getByText("com.example.alpha")).toBeInTheDocument()
  })

  it("exposes direct edit only for user agents", async () => {
    const user = userEvent.setup()
    const onEdit = vi.fn()

    renderJobList({ onEdit })

    await user.click(screen.getByTitle("Edit"))

    expect(onEdit).toHaveBeenCalledWith(mockJobs[0])
    expect(screen.getAllByTitle("Cannot edit system agents")[0]).toBeDisabled()
  })

  it("shows the direct stop start edit and delete actions for user agents", () => {
    renderJobList({
      jobs: [
        {
          ...mockJobs[0],
          status: "Running",
          source: "UserAgent",
    is_home_agent: true,
        },
      ],
    })

    expect(screen.getByTitle("Stop")).toBeInTheDocument()
    expect(screen.getByTitle("Restart")).toBeInTheDocument()
    expect(screen.getByTitle("Edit")).toBeInTheDocument()
    expect(screen.getAllByTitle("Delete").length).toBeGreaterThan(0)
  })
  it("runs loaded user agents and disables the system action", () => {
    const onKickstart = vi.fn()
    renderJobList({ onKickstart })
    screen.getByRole("button", { name: "Run now" }).click()
    expect(onKickstart).toHaveBeenCalledWith(mockJobs[0])
    expect(screen.getByRole("button", { name: "Cannot run system agents" })).toBeDisabled()
    expect(screen.queryByTitle("Cannot run unloaded agents")).not.toBeInTheDocument()
  })
})
