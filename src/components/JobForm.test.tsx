import { afterEach, describe, expect, it, vi } from "vitest"
import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  createEmptyJobFormDraft,
  createJobFormDraftFromJob,
  createRepairJobFormDraftFromJob,
  JobForm,
} from "./JobForm"
import type { LaunchdJob } from "@/types"
import { resetFakeHandlers, setFakeHandler } from "@/test-utils/tauri-mock"

describe("JobForm draft helpers", () => {
  afterEach(() => {
    resetFakeHandlers()
  })

  it("creates an empty durable draft", () => {
    const draft = createEmptyJobFormDraft()

    expect(draft.editing_plist_path).toBeNull()
    expect(draft.config.label).toBe("")
    expect(draft.args).toBe("")
    expect(draft.schedule_type).toBe("none")
    expect(draft.hour_mode).toBe("specific")
    expect(draft.hour_range).toEqual({ from: 7, to: 23 })
  })

  it("derives a draft from an existing job", () => {
    const job: LaunchdJob = {
      label: "com.example.agent",
      plist_path: "/Users/test/Library/LaunchAgents/com.example.agent.plist",
      source: "UserAgent",
      status: "Running",
      pid: 123,
      last_exit_code: 0,
      last_run_at: "1710000000000",
      plist: {
        label: "com.example.agent",
        program: "/usr/local/bin/agent",
        program_arguments: ["/usr/local/bin/agent", "--flag"],
        run_at_load: true,
        keep_alive: true,
        start_interval: null,
        start_calendar_interval: null,
        standard_out_path: null,
        standard_error_path: null,
        working_directory: null,
        environment_variables: null,
        disabled: false,
        wake_system: false,
        metadata: {
          group: "CAISS System",
          tags: ["caiss"],
          managed_by: "Daemonic",
          description: "Example agent",
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
        raw_xml: "<plist />",
      },
    }

    const draft = createJobFormDraftFromJob(job)

    expect(draft.editing_plist_path).toBe(job.plist_path)
    expect(draft.args).toBe('/usr/local/bin/agent --flag')
    expect(draft.config.label).toBe(job.label)
    expect(draft.schedule_type).toBe("none")
    expect(draft.hour_mode).toBe("specific")
  })

  it("captures the current calendar interval from an existing job draft", () => {
    const job: LaunchdJob = {
      label: "com.example.calendar",
      plist_path: "/Users/test/Library/LaunchAgents/com.example.calendar.plist",
      source: "UserAgent",
      status: "Loaded",
      pid: null,
      last_exit_code: 0,
      last_run_at: null,
      plist: {
        label: "com.example.calendar",
        program: "/usr/local/bin/calendar-agent",
        program_arguments: ["/usr/local/bin/calendar-agent"],
        run_at_load: true,
        keep_alive: false,
        start_interval: null,
        start_calendar_interval: [
          {
            minute: 15,
            hour: 9,
            day: null,
            weekday: null,
            month: null,
          },
        ],
        standard_out_path: null,
        standard_error_path: null,
        working_directory: null,
        environment_variables: null,
        disabled: false,
        wake_system: false,
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
        raw_xml: "<plist />",
      },
    }

    const draft = createJobFormDraftFromJob(job)

    expect(draft.schedule_type).toBe("calendar")
    expect(draft.hour_mode).toBe("specific")
    expect(draft.calendar_interval).toEqual({
      minute: 15,
      hour: 9,
      day: null,
      weekday: null,
      month: null,
    })
  })

  it("prefills repair health defaults from an inferred api template", () => {
    const job: LaunchdJob = {
      label: "com.example.api",
      plist_path: "/Users/test/Library/LaunchAgents/com.example.api.plist",
      source: "UserAgent",
      status: "Running",
      pid: 123,
      last_exit_code: 0,
      last_run_at: null,
      plist: {
        label: "com.example.api",
        program: "/usr/local/bin/api",
        program_arguments: ["/usr/local/bin/api"],
        run_at_load: true,
        keep_alive: true,
        start_interval: null,
        start_calendar_interval: null,
        standard_out_path: null,
        standard_error_path: null,
        working_directory: null,
        environment_variables: null,
        disabled: false,
        wake_system: false,
        metadata: {
          group: "CAISS System",
          tags: ["caiss", "api"],
          managed_by: "Daemonic",
          description: "Example API",
          environment: "local",
          health_check_url: null,
          health_check_command: null,
          ports: [],
          template: "api",
          migration_hint: null,
          health_status: "unknown",
          health_detail: "No explicit health check configured",
          last_health_check_at: null,
        },
        raw_xml: "<plist />",
      },
    }

    const draft = createRepairJobFormDraftFromJob(job)

    expect(draft.config.metadata.health_check_url).toBe("http://127.0.0.1:8001/health")
    expect(draft.config.metadata.health_check_command).toBeNull()
    expect(draft.config.metadata.ports).toEqual([8001])
    expect(draft.config.metadata.template).toBe("api")
  })

  it("prefills repair health defaults from a declared uptime kuma port", () => {
    const job: LaunchdJob = {
      label: "ai.cybergrunt.uptime-kuma",
      plist_path: "/Users/test/Library/LaunchAgents/ai.cybergrunt.uptime-kuma.plist",
      source: "UserAgent",
      status: "Running",
      pid: 1234,
      last_exit_code: 0,
      last_run_at: null,
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
        disabled: false,
        wake_system: false,
        metadata: {
          group: "CAISS System",
          tags: ["uptime-kuma", "monitoring"],
          managed_by: "Daemonic",
          description: "Uptime Kuma service",
          environment: "local",
          health_check_url: null,
          health_check_command: null,
          ports: [],
          template: null,
          migration_hint: "docker-compose",
          health_status: "unknown",
          health_detail: "No explicit health check configured",
          last_health_check_at: null,
        },
        raw_xml: "<plist />",
      },
    }

    const draft = createRepairJobFormDraftFromJob(job)

    expect(draft.config.metadata.health_check_url).toBe("http://127.0.0.1:3002/")
    expect(draft.config.metadata.health_check_command).toBeNull()
    expect(draft.config.metadata.ports).toEqual([3002])
    expect(draft.config.metadata.template).toBeNull()
  })

  it("closes when cancel is clicked", async () => {
    const user = userEvent.setup()
    const onClose = vi.fn()

    render(
      <JobForm
        open={true}
        onClose={onClose}
        onSave={vi.fn()}
        draft={null}
        onDraftChange={vi.fn()}
      />
    )

    await user.click(screen.getByRole("button", { name: "Cancel" }))

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it("uses the local model to prefill a new LaunchAgent draft", async () => {
    const user = userEvent.setup()
    const onDraftChange = vi.fn()

    setFakeHandler("get_agent_runtime_summary", () => ({
      provider: "Ollama",
      provider_label: "Ollama",
      configured: true,
      details: ["ollama", "llama3.2:1b"],
      readiness_checks: [
        { label: "Executable", status: "ready", detail: "ollama" },
        { label: "Model", status: "ready", detail: "llama3.2:1b" },
        { label: "Host", status: "ready", detail: "default local Ollama host" },
      ],
    }))
    setFakeHandler("run_agent_prompt", () => ({
      response: JSON.stringify({
        label: "com.example.backup-agent",
        args: "/usr/local/bin/backup.sh --target /Users/test/Backups",
        group: "CAISS System",
        tags: ["caiss", "backup"],
        managed_by: "Daemonic",
        description: "Nightly backup agent",
        environment: "local",
        schedule_type: "interval",
        run_at_load: true,
        keep_alive: false,
        start_interval: 900,
        calendar_interval: null,
        hour_mode: "specific",
        hour_range: { from: 7, to: 23 },
        working_directory: "/Users/test",
        standard_out_path: "/Users/test/Library/Logs/Daemonic/com.example.backup-agent.stdout.log",
        standard_error_path: "/Users/test/Library/Logs/Daemonic/com.example.backup-agent.stderr.log",
        environment_variables: { BACKUP_MODE: "incremental" },
        disabled: false,
        wake_system: false,
        summary: "Backup agent draft ready.",
        notes: ["Uses the provided backup script."],
        risks: ["Review generated command permissions."],
      }),
      command_line: "mock-runner --prompt",
    }))

    render(
      <JobForm
        open={true}
        onClose={vi.fn()}
        onSave={vi.fn()}
        draft={null}
        onDraftChange={onDraftChange}
      />
    )

    await waitFor(() => expect(screen.getByRole("button", { name: "Draft with AI" })).not.toBeDisabled())

    await user.type(
      screen.getByPlaceholderText(
        /Example: create a user LaunchAgent that runs \/usr\/local\/bin\/backup\.sh/i
      ),
      "Create a nightly backup LaunchAgent."
    )
    await user.click(screen.getByRole("button", { name: "Draft with AI" }))

    await screen.findByText("Backup agent draft ready. Notes: Uses the provided backup script. Risks: Review generated command permissions.")
    expect(screen.getByLabelText(/^Label/i)).toHaveValue("com.example.backup-agent")
    expect(screen.getByLabelText(/^Program Arguments/i)).toHaveValue(
      "/usr/local/bin/backup.sh --target /Users/test/Backups"
    )
    expect(screen.getByLabelText(/^Group/i)).toHaveValue("CAISS System")
    expect(screen.getByLabelText(/^Tags/i)).toHaveValue("caiss, backup")
    expect(screen.getByLabelText(/^Run at Load/i)).toBeInTheDocument()
    expect(screen.getByLabelText(/^Working Directory/i)).toHaveValue("/Users/test")
    expect(onDraftChange).toHaveBeenCalled()
  })

  it("persists calendar interval edits into the draft snapshot", async () => {
    const user = userEvent.setup()
    const onDraftChange = vi.fn()
    const draft = createEmptyJobFormDraft()
    draft.schedule_type = "calendar"
    draft.hour_mode = "specific"
    draft.calendar_interval = {
      minute: 15,
      hour: 9,
      day: null,
      weekday: null,
      month: null,
    }
    draft.config.start_calendar_interval = [draft.calendar_interval]

    render(
      <JobForm
        open={true}
        onClose={vi.fn()}
        onSave={vi.fn()}
        draft={draft}
        onDraftChange={onDraftChange}
      />
    )

    const minuteInput = screen.getByLabelText(/^Minute/i)
    await user.clear(minuteInput)
    await user.type(minuteInput, "30")

    await waitFor(() => {
      expect(onDraftChange).toHaveBeenLastCalledWith(
        expect.objectContaining({
          calendar_interval: expect.objectContaining({ minute: 30, hour: 9 }),
        })
      )
    })
  })

  it("applies the daily calendar preset", async () => {
    const user = userEvent.setup()

    render(
      <JobForm
        open={true}
        onClose={vi.fn()}
        onSave={vi.fn()}
        draft={null}
        onDraftChange={vi.fn()}
      />
    )

    await user.click(screen.getByRole("button", { name: "Daily 9:00" }))

    expect(screen.getByText("Run at specific time")).toBeInTheDocument()
    expect(screen.getAllByText("Specific hour").length).toBeGreaterThan(0)
    expect(screen.getByLabelText(/^Minute/i)).toHaveValue(0)
  })

  it("uses suggested repair metadata when the diagnosis has a concrete fix", () => {
    const job: LaunchdJob = {
      label: "ai.cybergrunt.uptime-kuma",
      plist_path: "/Users/test/Library/LaunchAgents/ai.cybergrunt.uptime-kuma.plist",
      source: "UserAgent",
      status: "Running",
      pid: 1234,
      last_exit_code: 0,
      last_run_at: null,
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
        disabled: false,
        wake_system: false,
        metadata: {
          group: "CAISS System",
          tags: ["uptime-kuma", "monitoring"],
          managed_by: "Daemonic",
          description: "Uptime Kuma service",
          environment: "local",
          health_check_url: null,
          health_check_command: null,
          ports: [3001],
          template: null,
          migration_hint: "docker-compose",
          health_status: "unknown",
          health_detail: "No explicit health check configured",
          last_health_check_at: null,
        },
        raw_xml: "<plist />",
      },
    }

    const draft = createRepairJobFormDraftFromJob(job, {
      group: "CAISS System",
      tags: ["uptime-kuma", "monitoring"],
      managed_by: "Daemonic",
      description: "Uptime Kuma service",
      environment: "local",
      health_check_url: "http://127.0.0.1:3002/",
      health_check_command: null,
      ports: [3002],
      template: "web",
      migration_hint: "docker-compose",
      health_status: "unknown",
      health_detail: "No explicit health check configured",
      last_health_check_at: null,
    })

    expect(draft.config.metadata.health_check_url).toBe("http://127.0.0.1:3002/")
    expect(draft.config.metadata.ports).toEqual([3002])
    expect(draft.config.metadata.template).toBeNull()
  })
})

it("rehydrates a delayed draft, switches targets, and clears on reopening an empty draft", async () => {
  const props = { onSave: vi.fn(), onClose: vi.fn(), onDraftChange: vi.fn() }
  const view = render(<JobForm {...props} open draft={null} />)
  const restored = createEmptyJobFormDraft()
  restored.config.label = "com.example.restored"
  restored.args = "restored command"
  restored.sensitive_fields_omitted = true
  view.rerender(<JobForm {...props} open draft={restored} />)
  expect(await screen.findByDisplayValue("com.example.restored")).toBeInTheDocument()
  expect(screen.getByText(/Restored drafts omit/)).toBeInTheDocument()
  const next = createEmptyJobFormDraft()
  next.config.label = "com.example.next"
  view.rerender(<JobForm {...props} open draft={next} />)
  expect(await screen.findByDisplayValue("com.example.next")).toBeInTheDocument()
  expect(screen.queryByDisplayValue("restored command")).not.toBeInTheDocument()
  view.rerender(<JobForm {...props} open={false} draft={null} />)
  view.rerender(<JobForm {...props} open draft={null} />)
  expect(screen.queryByDisplayValue("com.example.next")).not.toBeInTheDocument()
  await act(async () => undefined)
  view.unmount()
})

it("does not close or clear a newly selected draft when an older save finishes", async () => {
  let finish!: () => void
  const onSave = vi.fn(() => new Promise<void>((resolve) => { finish = resolve }))
  const props = { onSave, onClose: vi.fn(), onDraftChange: vi.fn() }
  const old = createEmptyJobFormDraft()
  old.config.label = "com.example.old"
  const view = render(<JobForm {...props} open draft={old} />)
  await userEvent.setup().click(screen.getByRole("button", { name: "Create" }))
  await waitFor(() => expect(onSave).toHaveBeenCalled())
  const next = createEmptyJobFormDraft()
  next.config.label = "com.example.next"
  view.rerender(<JobForm {...props} open draft={next} />)
  await act(async () => finish())
  await waitFor(() => expect(screen.getByDisplayValue("com.example.next")).toBeInTheDocument())
  expect(props.onClose).not.toHaveBeenCalled()
  expect(props.onDraftChange).not.toHaveBeenCalledWith(null)
})

it.each(["toString", "constructor", "__proto__"])("does not treat inherited template %s as a preset", (template) => {
  const config = createEmptyJobFormDraft().config
  const job: LaunchdJob = { label: "com.example.custom", plist_path: "/Users/test/Library/LaunchAgents/com.example.custom.plist", source: "UserAgent", status: "Loaded", pid: null, last_exit_code: 0, last_run_at: null, plist: { ...config, label: "com.example.custom", metadata: { ...config.metadata, template } } }
  const repaired = createRepairJobFormDraftFromJob(job)
  expect(repaired.config.metadata.health_check_url).toBeNull()
  expect(repaired.config.metadata.ports).toEqual([])
})

it("honors explicit empty repair fields rather than restoring previous values", () => {
  const config = createEmptyJobFormDraft().config
  const job: LaunchdJob = { label: "com.example.api", plist_path: "/Users/test/Library/LaunchAgents/com.example.api.plist", source: "UserAgent", status: "Loaded", pid: null, last_exit_code: 0, last_run_at: null, plist: { ...config, label: "com.example.api", metadata: { ...config.metadata, template: "api", health_check_url: "http://127.0.0.1:8001/health", ports: [8001] } } }
  const repaired = createRepairJobFormDraftFromJob(job, config.metadata)
  expect(repaired.config.metadata.health_check_url).toBeNull()
  expect(repaired.config.metadata.template).toBeNull()
  expect(repaired.config.metadata.ports).toEqual([])
})

it("blocks saving an omitted restored draft and an invalid calendar range", async () => {
  const onSave = vi.fn()
  const props = { onSave, onClose: vi.fn(), onDraftChange: vi.fn() }
  const restored = createEmptyJobFormDraft()
  restored.config.label = "com.example.restored"
  restored.sensitive_fields_omitted = true
  const view = render(<JobForm {...props} open draft={restored} />)
  await userEvent.setup().click(screen.getByRole("button", { name: "Create" }))
  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getByText(/This restored draft omitted sensitive fields/)).toBeInTheDocument()
  const invalid = createEmptyJobFormDraft()
  invalid.config.label = "com.example.invalid"
  invalid.schedule_type = "calendar"
  invalid.hour_mode = "range"
  invalid.calendar_interval = { minute: 99, hour: null, day: null, month: null, weekday: null }
  view.rerender(<JobForm {...props} open draft={invalid} />)
  await userEvent.setup().click(screen.getByRole("button", { name: "Create" }))
  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getByText(/minute must be a whole number/)).toBeInTheDocument()
  view.unmount()
})

it.each(["65536", "80.5"])("rejects invalid manual port %s instead of truncating it", async (port) => {
  const draft = createEmptyJobFormDraft()
  draft.config.label = "com.example.ports"
  const onSave = vi.fn()
  const view = render(<JobForm open draft={draft} onSave={onSave} onClose={vi.fn()} onDraftChange={vi.fn()} />)
  await userEvent.setup().type(screen.getByLabelText("Ports"), port)
  await userEvent.setup().click(screen.getByRole("button", { name: "Create" }))
  expect(onSave).not.toHaveBeenCalled()
  expect(screen.getByText("Ports must be whole numbers from 1 to 65535.")).toBeInTheDocument()
  view.unmount()
})

it("supports explicitly clearing manually entered ports", async () => {
  const draft = createEmptyJobFormDraft()
  draft.config.label = "com.example.ports"
  draft.config.metadata.ports = [8001]
  const onSave = vi.fn()
  const view = render(<JobForm open draft={draft} onSave={onSave} onClose={vi.fn()} onDraftChange={vi.fn()} />)
  await userEvent.setup().clear(screen.getByLabelText("Ports"))
  await userEvent.setup().click(screen.getByRole("button", { name: "Create" }))
  expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ ports: [] }) }), undefined)
  view.unmount()
})
