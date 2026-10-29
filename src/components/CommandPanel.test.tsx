import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { CommandPanel, buildCommands, shellQuote } from "@/components/CommandPanel"
import type { LaunchdJob } from "@/types"

function job(overrides: Partial<LaunchdJob>): LaunchdJob {
  return {
    label: "com.example.agent",
    plist_path: "/Users/test/Library/LaunchAgents/com.example.agent.plist",
    source: "UserAgent",
    status: "Running",
    pid: 1234,
    last_exit_code: 0,
    last_run_at: null,
    plist: {
      metadata: { group: null, tags: [], managed_by: null, description: null, environment: null, health_check_url: null, health_check_command: null, ports: [], template: null, migration_hint: null, health_status: null, health_detail: null, last_health_check_at: null },
      label: "com.example.agent",
      program: "/usr/bin/true",
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
      raw_xml: "",
    },
    ...overrides,
  }
}

describe("CommandPanel command builders", () => {
  it("quotes shell paths only when needed", () => {
    expect(shellQuote("/tmp/com.example.plist")).toBe("/tmp/com.example.plist")
    expect(shellQuote("/tmp/Launch Agents/example's job.plist")).toBe(
      "'/tmp/Launch Agents/example'\\''s job.plist'"
    )
  })

  it("builds user agent commands like the backend launchctl wrapper", () => {
    const commands = buildCommands(job({}))

    expect(commands.map((item) => item.command)).toEqual([
      "launchctl bootstrap gui/$(id -u) /Users/test/Library/LaunchAgents/com.example.agent.plist",
      "launchctl bootout gui/$(id -u) /Users/test/Library/LaunchAgents/com.example.agent.plist",
      "launchctl kickstart -k gui/$(id -u)/com.example.agent",
      "launchctl enable gui/$(id -u)/com.example.agent",
      "launchctl disable gui/$(id -u)/com.example.agent",
      "rm /Users/test/Library/LaunchAgents/com.example.agent.plist",
    ])
  })

  it("quotes labels in service targets", () => {
    const commands = buildCommands(
      job({
        label: "com.example.agent's job",
      })
    )

    expect(commands.map((item) => item.command)).toContain(
      "launchctl kickstart -k gui/$(id -u)/'com.example.agent'\\''s job'"
    )
    expect(commands.map((item) => item.command)).toContain(
      "launchctl enable gui/$(id -u)/'com.example.agent'\\''s job'"
    )
    expect(commands.map((item) => item.command)).toContain(
      "launchctl disable gui/$(id -u)/'com.example.agent'\\''s job'"
    )
  })

  it("only offers inspection for system agents and daemons", () => {
    for (const source of ["SystemAgent", "SystemDaemon"] as const) {
      const commands = buildCommands(job({ source }))
      expect(commands).toEqual([{ label: "Inspect", command: `launchctl print ${source === "SystemDaemon" ? "system" : "gui/$(id -u)"}/com.example.agent` }])
      expect(commands.some(({ command }) => /sudo|rm|bootout|bootstrap|kickstart|enable|disable/.test(command))).toBe(false)
    }
  })
})


afterEach(() => vi.restoreAllMocks())

it("reports copied commands and clipboard failure without executing IPC", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } })
  render(<CommandPanel job={job({})} />)
  fireEvent.click(screen.getByRole("button", { name: "Copy start command" }))
  await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining("launchctl bootstrap")))
  await waitFor(() => expect(screen.getByRole("button", { name: "Copy start command" }).querySelector('svg.lucide-check')).not.toBeNull())
  writeText.mockRejectedValue(new Error("denied"))
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn().mockReturnValue(false) })
  fireEvent.click(screen.getByRole("button", { name: "Copy stop command" }))
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not copy command")
})
