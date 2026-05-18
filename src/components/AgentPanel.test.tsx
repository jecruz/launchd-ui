import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AgentPanel } from "./AgentPanel"
import type { JobListEntry } from "@/types"
import { resetFakeHandlers, setFakeHandler } from "@/test-utils/tauri-mock"

const selectedJob: JobListEntry = {
  label: "com.example.running-agent",
  pid: 123,
  last_exit_code: 0,
  plist_path: "/Users/test/Library/LaunchAgents/com.example.running-agent.plist",
  source: "UserAgent",
  status: "Running",
  last_run_at: null,
}

function installProposalHandlers(job: JobListEntry) {
  setFakeHandler("run_agent_prompt", () => ({
    response: JSON.stringify({
      mode: "approval",
      action: "proposal",
      target: job.label,
      summary: "Kickstart the selected job.",
      risks: [],
      recommended_next_step: "Apply the approved action.",
      approval_required: true,
      command_proposal: `launchctl kickstart -k gui/501/${job.label}`,
      verification: ["Refresh the job list"],
    }),
    command_line: "mock-runner --prompt",
  }))
}

function approvalCheckbox() {
  return screen.getByRole("checkbox", {
    name: /I reviewed the proposed action and approve a local user-agent mutation/i,
  })
}

describe("AgentPanel timeline", () => {
  afterEach(() => {
    resetFakeHandlers()
  })

  it("moves from proposal to approval, apply, and verification", async () => {
    const user = userEvent.setup()
    const onApplied = vi.fn()

    installProposalHandlers(selectedJob)

    setFakeHandler("apply_approved_agent_action", () => ({
      action: "Kickstart",
      command: "launchctl kickstart -k gui/501/com.example.running-agent",
      verified_status: "Running",
      verified_pid: 456,
      verified_last_exit_code: 0,
    }))

    render(<AgentPanel mode="approval" selectedJob={selectedJob} onApplied={onApplied} />)

    await screen.findByText("0/5 stages complete")
    await user.click(screen.getByText("Propose command").closest("button")!)
    await user.click(approvalCheckbox())
    const runButton = screen.getByRole("button", { name: "Run Prompt" })
    await waitFor(() => expect(runButton).not.toBeDisabled())
    await user.click(runButton)

    await waitFor(() => expect(screen.getAllByText("Kickstart the selected job.").length).toBeGreaterThanOrEqual(2))
    expect(screen.getAllByText("Preview").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Needs approval").length).toBeGreaterThan(0)

    await user.click(approvalCheckbox())
    await user.click(screen.getByRole("button", { name: "Apply Approved Action" }))

    await waitFor(() => expect(onApplied).toHaveBeenCalledTimes(1))
    expect(screen.getByText("5/5 stages complete")).toBeInTheDocument()
    expect(screen.getByText("Post-apply state")).toBeInTheDocument()
    expect(screen.getByText("456")).toBeInTheDocument()
  })

  it.each([
    {
      label: "system agent",
      source: "SystemAgent" as const,
      plistPath: "/Library/LaunchAgents/com.example.system-agent.plist",
    },
    {
      label: "system daemon",
      source: "SystemDaemon" as const,
      plistPath: "/Library/LaunchDaemons/com.example.system-daemon.plist",
    },
  ])("keeps apply controls hidden for $label proposals", async ({ source, plistPath }) => {
    const user = userEvent.setup()
    const readOnlyJob: JobListEntry = {
      ...selectedJob,
      label: `com.example.${source}`,
      plist_path: plistPath,
      source,
    }

    installProposalHandlers(readOnlyJob)

    render(<AgentPanel mode="approval" selectedJob={readOnlyJob} onApplied={vi.fn()} />)

    await screen.findByText("0/5 stages complete")
    await user.click(screen.getByText("Propose command").closest("button")!)
    await user.click(approvalCheckbox())
    const runButton = screen.getByRole("button", { name: "Run Prompt" })
    await waitFor(() => expect(runButton).not.toBeDisabled())
    await user.click(runButton)

    await waitFor(() => expect(screen.getAllByText("Kickstart the selected job.").length).toBeGreaterThanOrEqual(2))

    expect(screen.getByText("Read-only")).toBeInTheDocument()
    expect(
      screen.getByText("System-owned jobs remain read-only and cannot be applied from the timeline.")
    ).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Apply Approved Action" })).not.toBeInTheDocument()
  })

  it("prevents prompt execution when runtime settings are incomplete", async () => {
    const runAgentPrompt = vi.fn()

    setFakeHandler("get_agent_runtime_summary", () => ({
      provider: "Ollama",
      provider_label: "Ollama",
      configured: false,
      details: ["missing model name"],
      readiness_checks: [
        { label: "Executable", status: "ready", detail: "ollama" },
        { label: "Model", status: "missing", detail: "Set an Ollama model name." },
      ],
    }))
    setFakeHandler("run_agent_prompt", runAgentPrompt)

    render(<AgentPanel mode="approval" selectedJob={selectedJob} onApplied={vi.fn()} />)

    expect(await screen.findByRole("button", { name: "Configure runtime" })).toBeDisabled()
    expect(screen.getAllByText("Set an Ollama model name.").length).toBeGreaterThan(0)
    expect(runAgentPrompt).not.toHaveBeenCalled()
  })

  it("runs a lightweight smoke prompt without job context", async () => {
    const user = userEvent.setup()
    const runAgentPrompt = vi.fn(() => ({
      response: "runtime ok",
      command_line: "ollama run llama3.2:1b",
    }))

    setFakeHandler("run_agent_prompt", runAgentPrompt)

    render(<AgentPanel mode="approval" selectedJob={selectedJob} onApplied={vi.fn()} />)

    const smokeButton = await screen.findByRole("button", { name: "Smoke Test Runtime" })
    await waitFor(() => expect(smokeButton).not.toBeDisabled())
    await user.click(smokeButton)

    await screen.findByText("Smoke result")
    expect(screen.getByText("runtime ok")).toBeInTheDocument()
    expect(runAgentPrompt).toHaveBeenCalledWith({
      request: {
        prompt: "Reply with exactly: runtime ok",
        job_context: null,
        mode: "smoke",
      },
    })
  })

  it("records assistant turns in conversation history with proactive insights", async () => {
    const user = userEvent.setup()

    installProposalHandlers(selectedJob)

    render(<AgentPanel mode="approval" selectedJob={selectedJob} onApplied={vi.fn()} />)

    expect(await screen.findByText("Proactive insights")).toBeInTheDocument()
    expect(screen.getByText("Local job signals before prompting")).toBeInTheDocument()
    await user.click(screen.getByText("Propose command").closest("button")!)
    await user.click(approvalCheckbox())
    await user.click(screen.getByRole("button", { name: "Run Prompt" }))

    await screen.findByText("Conversation history")
    expect(screen.getByText("Last local assistant turns")).toBeInTheDocument()
    expect(screen.getByText("Command proposed")).toBeInTheDocument()
  })

  it("auto-applies safe user-agent proposals when semi-autonomous mode is enabled", async () => {
    const user = userEvent.setup()
    const onApplied = vi.fn()
    const applyApprovedAgentAction = vi.fn(() => ({
      action: "Kickstart",
      command: "launchctl kickstart -k gui/501/com.example.running-agent",
      verified_status: "Running",
      verified_pid: 789,
      verified_last_exit_code: 0,
    }))

    installProposalHandlers(selectedJob)
    setFakeHandler("apply_approved_agent_action", applyApprovedAgentAction)

    render(<AgentPanel mode="approval" selectedJob={selectedJob} onApplied={onApplied} />)

    await screen.findByText("0/5 stages complete")
    await user.click(screen.getByRole("checkbox", { name: /Semi-autonomous mode/i }))
    await user.click(screen.getByText("Propose command").closest("button")!)
    const runButton = screen.getByRole("button", { name: "Run Prompt" })
    await waitFor(() => expect(runButton).not.toBeDisabled())
    await user.click(runButton)

    await waitFor(() => expect(applyApprovedAgentAction).toHaveBeenCalledTimes(1))
    expect(onApplied).toHaveBeenCalledTimes(1)
    expect(screen.getByText("789")).toBeInTheDocument()
  })
})
