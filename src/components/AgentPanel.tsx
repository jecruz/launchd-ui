import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CopyableCodeBlock } from "@/components/CopyableBlock"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { describeHealth } from "@/lib/health"
import type {
  AgentRuntimeProvider,
  AgentRuntimeSettings,
  AgentRuntimeSummary,
  JobListEntry,
  PromptInputMode,
} from "@/types"
import {
  applyApprovedAgentAction,
  getAgentRuntimeSettings,
  getAgentRuntimeSummary,
  getJobDetail,
  runAgentPrompt,
  saveAgentRuntimeSettings,
} from "@/lib/invoke"
import type { LaunchdJob } from "@/types"
import { extractJsonObject, type AgentAction, type StructuredAgentResult } from "@/lib/agent-output"

type AgentPanelProps = {
  mode: "copilot" | "approval" | "assistant"
  selectedJob: JobListEntry | null
  onApplied?: () => Promise<void> | void
}

type ActionPreview = {
  before: string
  after: string
  effect: string
  verification: string[]
  beforeStatus: string
  afterStatus: string
}

type TimelineStepState = "done" | "active" | "ready" | "locked" | "idle"

type TimelineStep = {
  id: string
  title: string
  eyebrow: string
  state: TimelineStepState
  body: ReactNode
}

type ConversationEntry = {
  id: string
  action: AgentAction
  prompt: string
  summary: string
  response: string
  commandProposal: string | null
}

const providerOptions: Array<{ value: AgentRuntimeProvider; label: string }> = [
  { value: "LlamaCpp", label: "llama.cpp / yama.cpp" },
  { value: "Ollama", label: "Ollama" },
  { value: "LocalCli", label: "Custom local CLI" },
]

const promptModeOptions: Array<{ value: PromptInputMode; label: string }> = [
  { value: "Stdin", label: "Prompt on stdin" },
  { value: "Argument", label: "Prompt as argument" },
]

function buildJobContext(job: JobListEntry | null): string | null {
  if (!job) return null
  return [
    `Label: ${job.label}`,
    `Source: ${job.source}`,
    `Status: ${job.status}`,
    `PID: ${job.pid ?? "—"}`,
    `Last exit code: ${job.last_exit_code ?? "—"}`,
    `Plist path: ${job.plist_path}`,
    `Group: ${job.metadata.group ?? "Ungrouped"}`,
    `Tags: ${job.metadata.tags.length > 0 ? job.metadata.tags.join(", ") : "—"}`,
    `Ports: ${job.metadata.ports.length > 0 ? job.metadata.ports.join(", ") : "—"}`,
    `Health: ${describeHealth(job)}`,
  ].join("\n")
}

function buildDetailedJobContext(job: LaunchdJob | null): string | null {
  if (!job) return null
  const plist = job.plist
  const env = plist.environment_variables
  const envLines =
    env && Object.keys(env).length > 0
      ? Object.entries(env)
          .map(([key, value]) => `${key}=${value}`)
          .join("\n")
      : "—"

  const args = plist.program_arguments?.length
    ? plist.program_arguments.map((arg, index) => `  [${index}] ${arg}`).join("\n")
    : "—"

  return [
    `Label: ${job.label}`,
    `Source: ${job.source}`,
    `Status: ${job.status}`,
    `PID: ${job.pid ?? "—"}`,
    `Last exit code: ${job.last_exit_code ?? "—"}`,
    `Last run at: ${job.last_run_at ?? "—"}`,
    `Plist path: ${job.plist_path}`,
    `Program: ${plist.program ?? "—"}`,
    `Program arguments:\n${args}`,
    `RunAtLoad: ${plist.run_at_load ?? "—"}`,
    `KeepAlive: ${plist.keep_alive ?? "—"}`,
    `StartInterval: ${plist.start_interval ?? "—"}`,
    `WorkingDirectory: ${plist.working_directory ?? "—"}`,
    `Stdout: ${plist.standard_out_path ?? "—"}`,
    `Stderr: ${plist.standard_error_path ?? "—"}`,
    `HealthCheckURL: ${plist.metadata.health_check_url ?? "—"}`,
    `HealthCheckCommand: ${plist.metadata.health_check_command ?? "—"}`,
    `Ports: ${plist.metadata.ports.length > 0 ? plist.metadata.ports.join(", ") : "—"}`,
    `Template: ${plist.metadata.template ?? "—"}`,
    `EnvironmentVariables:\n${envLines}`,
    `Disabled: ${plist.disabled ?? "—"}`,
    `WakeSystem: ${plist.wake_system ?? "—"}`,
    `Raw plist:\n${plist.raw_xml || "—"}`,
  ].join("\n")
}

function defaultPrompt(mode: AgentPanelProps["mode"], job: JobListEntry | null): string {
  const target = job ? `the selected job ${job.label}` : "the current launchd inventory"
  if (mode === "copilot") {
    return `Explain ${target} and propose the safest next action. Do not execute anything.`
  }
  if (mode === "approval") {
    return `Inspect ${target}. If the action is safe, suggest the exact step and note whether approval is needed.`
  }
  return `Act as a launchd assistant for ${target}. Summarize what matters and draft the next command or fix.`
}

function actionPrompt(action: AgentAction, mode: AgentPanelProps["mode"], job: JobListEntry | null): string {
  const target = job ? `the selected job ${job.label}` : "the current launchd inventory"
  const shared =
    `Use the provided launchd context. Current agent mode is ${mode}. Prefer concrete file paths and specific launchctl commands when relevant. Do not claim that any action was executed.`

  if (action === "summary") {
    return [
      `Summarize ${target} for a macOS operator.`,
      "Return valid JSON only with these keys: mode, action, target, summary, risks, recommended_next_step, approval_required, command_proposal, verification.",
      "For summary mode, keep approval_required false and command_proposal null.",
      shared,
    ].join("\n")
  }

  if (action === "remediation") {
    return [
      `Draft a safe remediation plan for ${target}.`,
      "Return valid JSON only with these keys: mode, action, target, summary, risks, recommended_next_step, approval_required, command_proposal, verification.",
      "For remediation, make approval_required true when any mutation is suggested. If no mutation is needed, set it false.",
      "If the job looks healthy, say so and describe what to monitor instead of inventing a problem.",
      shared,
    ].join("\n")
  }

  return [
    `Draft a launchctl command proposal for ${target}.`,
    "Return valid JSON only with these keys: mode, action, target, summary, risks, recommended_next_step, approval_required, command_proposal, verification.",
    "Set approval_required true. Put the exact command proposal in command_proposal. Do not imply execution already happened.",
    "If the target is a user agent, prefer the relevant start, stop, restart, kickstart, enable, or disable command as appropriate.",
    "If the target is system-owned, explain that it should remain read-only.",
    shared,
  ].join("\n")
}

function inferActionPreview(
  job: JobListEntry | null,
  result: StructuredAgentResult | null
): ActionPreview | null {
  if (!job || !result?.command_proposal) return null

  const command = result.command_proposal.toLowerCase()
  let effect = "Apply the proposed launchd action."
  if (command.includes("kickstart")) {
    effect = "Kickstart the selected user agent without changing its plist."
  } else if (command.includes("bootstrap")) {
    effect = "Load or start the selected user agent."
  } else if (command.includes("bootout")) {
    effect = "Unload or stop the selected user agent."
  } else if (command.includes("enable")) {
    effect = "Enable the selected launchd job."
  } else if (command.includes("disable")) {
    effect = "Disable the selected launchd job."
  }

  let afterStatus = job.status
  if (command.includes("kickstart") || command.includes("bootstrap")) {
    afterStatus = "Running"
  } else if (command.includes("bootout")) {
    afterStatus = "Unloaded"
  } else if (command.includes("enable") || command.includes("disable")) {
    afterStatus = "Loaded"
  }

  return {
    before: `${job.label} is currently ${job.status}${job.pid ? ` with PID ${job.pid}` : ""}.`,
    after: result.command_proposal,
    effect,
    verification: result.verification,
    beforeStatus: job.status,
    afterStatus,
  }
}

function buildProactiveInsights(job: JobListEntry | null, detail: LaunchdJob | null): string[] {
  if (!job) return ["Select a launchd job to generate local insights."]

  const insights: string[] = []
  const lastExitCode = detail?.last_exit_code ?? job.last_exit_code
  const status = detail?.status ?? job.status
  const plist = detail?.plist

  if (job.source !== "UserAgent") {
    insights.push("System-owned job: inspect only; keep mutation controls locked.")
  }
  if (lastExitCode !== null && lastExitCode !== 0) {
    insights.push(`Last exit code is ${lastExitCode}; inspect stderr before restarting.`)
  }
  if (status === "Running" && (detail?.pid ?? job.pid)) {
    insights.push(`Running with PID ${detail?.pid ?? job.pid}; prefer logs before forcing a restart.`)
  }
  if (status === "Unloaded") {
    insights.push("Unloaded: bootstrap or enable may be needed if this should run now.")
  }
  if (plist?.disabled === true) {
    insights.push("Disabled in plist metadata; enable before expecting launchd to run it.")
  }
  if (plist?.keep_alive === true && status !== "Running") {
    insights.push("KeepAlive is set but the job is not running; check crash loops and permissions.")
  }
  if (plist?.standard_error_path) {
    insights.push(`stderr is configured at ${plist.standard_error_path}.`)
  }
  if (plist?.metadata.ports.length) {
    insights.push(`Ports configured: ${plist.metadata.ports.join(", ")}.`)
  }
  if (plist?.metadata.health_check_url) {
    insights.push(`Health check URL configured: ${plist.metadata.health_check_url}.`)
  } else if (plist?.metadata.health_check_command) {
    insights.push("Health check command configured for the selected job.")
  }

  return insights.length ? insights : ["No obvious risk flags from the current job snapshot."]
}

function isSafeAutoApplyProposal(job: JobListEntry | null, result: StructuredAgentResult | null): boolean {
  if (!job || job.source !== "UserAgent" || !result?.command_proposal) return false
  const command = result.command_proposal.toLowerCase()
  const sensitive = ["bootout", "disable", "stop", "restart"].some((term) => command.includes(term))
  const safeStart = command.includes("kickstart") || command.includes("bootstrap") || command.includes(" start")
  return safeStart && !sensitive
}

export function AgentPanel({ mode, selectedJob, onApplied }: AgentPanelProps) {
  const [settings, setSettings] = useState<AgentRuntimeSettings | null>(null)
  const [prompt, setPrompt] = useState("")
  const [response, setResponse] = useState("")
  const [commandLine, setCommandLine] = useState("")
  const [saving, setSaving] = useState(false)
  const [running, setRunning] = useState(false)
  const [smokeRunning, setSmokeRunning] = useState(false)
  const [smokeResult, setSmokeResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [summary, setSummary] = useState<AgentRuntimeSummary | null>(null)
  const [jobDetail, setJobDetail] = useState<LaunchdJob | null>(null)
  const [verificationDetail, setVerificationDetail] = useState<LaunchdJob | null>(null)
  const [activeAction, setActiveAction] = useState<AgentAction>("summary")
  const [approvalConfirmed, setApprovalConfirmed] = useState(false)
  const [structuredResult, setStructuredResult] = useState<StructuredAgentResult | null>(null)
  const [appliedAction, setAppliedAction] = useState<string | null>(null)
  const [autoApplySafeActions, setAutoApplySafeActions] = useState(false)
  const [conversation, setConversation] = useState<ConversationEntry[]>([])

  const jobContext = useMemo(() => buildJobContext(selectedJob), [selectedJob])
  const proactiveInsights = useMemo(
    () => buildProactiveInsights(selectedJob, jobDetail),
    [jobDetail, selectedJob]
  )

  useEffect(() => {
    Promise.all([getAgentRuntimeSettings(), getAgentRuntimeSummary()])
      .then(([loadedSettings, loadedSummary]) => {
        setSettings(loadedSettings)
        setSummary(loadedSummary)
        setPrompt((current) => current || defaultPrompt(mode, selectedJob))
      })
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    setPrompt((current) => current || defaultPrompt(mode, selectedJob))
  }, [mode, selectedJob])

  useEffect(() => {
    if (!selectedJob) {
      setJobDetail(null)
      setVerificationDetail(null)
      setStructuredResult(null)
      setAppliedAction(null)
      setApprovalConfirmed(false)
      return
    }

    let cancelled = false
    getJobDetail(selectedJob.plist_path)
      .then((detail) => {
        if (!cancelled) {
          setJobDetail(detail)
          setVerificationDetail(null)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setJobDetail(null)
        }
      })

    return () => {
      cancelled = true
    }
  }, [selectedJob])

  useEffect(() => {
    setVerificationDetail(null)
    setAppliedAction(null)
    setApprovalConfirmed(false)
  }, [selectedJob?.plist_path])

  const provider = settings?.provider ?? "Ollama"
  const actionPreview = useMemo(
    () => inferActionPreview(selectedJob, structuredResult),
    [selectedJob, structuredResult]
  )

  const applyStructuredAction = async (proposal: StructuredAgentResult, automatic = false) => {
    if (!selectedJob || selectedJob.source !== "UserAgent") {
      setError("Only user agents can be mutated from the approved action path.")
      return
    }
    if (!proposal.command_proposal) {
      setError("No command proposal is available to apply.")
      return
    }
    if (proposal.target !== selectedJob.label) {
      setError("The proposal target no longer matches the selected job.")
      return
    }
    setError(null)
    setAppliedAction(null)
    try {
      const result = await applyApprovedAgentAction({
        plist_path: selectedJob.plist_path,
        label: selectedJob.label,
        command_proposal: proposal.command_proposal,
        auto_apply: automatic,
      })
      setAppliedAction(`${result.action}: ${result.command}`)
      setVerificationDetail({
        ...(jobDetail ?? selectedJob),
        plist: jobDetail?.plist ?? {
          label: selectedJob.label,
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
          metadata: selectedJob.metadata,
          raw_xml: "",
        },
        label: selectedJob.label,
        plist_path: selectedJob.plist_path,
        source: selectedJob.source,
        status: result.verified_status,
        pid: result.verified_pid,
        last_exit_code: result.verified_last_exit_code,
        last_run_at: jobDetail?.last_run_at ?? selectedJob.last_run_at,
      })
      await onApplied?.()
    } catch (e) {
      setError(String(e))
      throw e
    }
  }

  const handleApplyApprovedAction = async () => {
    if (!structuredResult) return
    setRunning(true)
    try {
      await applyStructuredAction(structuredResult)
    } finally {
      setRunning(false)
    }
  }

  const timelineSteps = useMemo<TimelineStep[]>(() => {
    const currentStatus = verificationDetail?.status ?? jobDetail?.status ?? selectedJob?.status ?? "Unknown"
    const statusLabel = selectedJob
      ? `${selectedJob.label} • ${currentStatus}`
      : "No job selected"
    const summaryBody: ReactNode = structuredResult ? (
      <div className="space-y-2">
        <p className="text-sm text-cyan-50/90">{structuredResult.summary || "No summary returned."}</p>
        <p className="text-xs text-cyan-100/70">{statusLabel}</p>
      </div>
    ) : (
      <p className="text-sm text-slate-300">
        Run the summary action to populate the timeline with evidence-backed context.
      </p>
    )

    const previewBody: ReactNode =
      activeAction === "proposal" ? (
        actionPreview ? (
          <div className="space-y-2">
            <div className="rounded-xl border border-white/10 bg-black/20 p-3 font-mono text-xs leading-5 text-amber-50">
              <div className="text-rose-200">- {actionPreview.before}</div>
              <div className="text-emerald-200">+ {actionPreview.after}</div>
              <div className="mt-2 text-amber-100">{actionPreview.effect}</div>
            </div>
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                <p className="text-[11px] uppercase tracking-[0.22em] text-amber-100/70">
                  Before
                </p>
                <p className="mt-1 text-sm font-medium text-white">{actionPreview.beforeStatus}</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                <p className="text-[11px] uppercase tracking-[0.22em] text-amber-100/70">
                  After
                </p>
                <p className="mt-1 text-sm font-medium text-white">{actionPreview.afterStatus}</p>
              </div>
              <div className="rounded-lg border border-white/10 bg-white/5 p-3">
                <p className="text-[11px] uppercase tracking-[0.22em] text-amber-100/70">
                  Job
                </p>
                <p className="mt-1 text-sm font-medium text-white">{selectedJob?.label ?? "—"}</p>
              </div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-amber-50/80">
            Run the proposal prompt to generate a state transition preview.
          </p>
        )
      ) : (
        <p className="text-sm text-slate-300">
          Switch to proposal mode when you want the panel to generate a command preview.
        </p>
      )

    const approvalBody: ReactNode = (
      <label className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-slate-200">
        <input
          type="checkbox"
          checked={approvalConfirmed}
          onChange={(e) => setApprovalConfirmed(e.target.checked)}
          className="mt-1 h-4 w-4 rounded border-white/20 bg-slate-950 text-cyan-500 focus:ring-cyan-400"
        />
        <span className="leading-6">
          I reviewed the proposed action and approve a local user-agent mutation only after the timeline is fully populated.
        </span>
      </label>
    )

    const applyBody: ReactNode =
      selectedJob?.source === "UserAgent" ? (
        <div className="space-y-3">
          <p className="text-sm text-slate-300">
            The deterministic executor will only apply a classified launchd action after approval.
          </p>
          {structuredResult?.command_proposal &&
            activeAction === "proposal" &&
            approvalConfirmed && (
              <Button
                variant="outline"
                onClick={handleApplyApprovedAction}
                disabled={running}
                className="border-emerald-400/30 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/20"
              >
                {running ? "Applying..." : "Apply Approved Action"}
              </Button>
            )}
          {appliedAction && (
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-100">
              <p className="mb-1 text-xs uppercase tracking-[0.24em] text-emerald-300">
                Applied
              </p>
              <p className="font-mono text-xs leading-5">{appliedAction}</p>
            </div>
          )}
        </div>
      ) : (
        <p className="text-sm text-slate-300">
          System-owned jobs remain read-only and cannot be applied from the timeline.
        </p>
      )

    const verifyBody: ReactNode = verificationDetail ? (
      <div className="space-y-2">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-lg border border-white/10 bg-white/5 p-3">
            <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-100/70">
              Post-apply state
            </p>
            <p className="mt-1 text-sm font-medium text-white">{verificationDetail.status}</p>
          </div>
          <div className="rounded-lg border border-white/10 bg-white/5 p-3">
            <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-100/70">
              PID
            </p>
            <p className="mt-1 text-sm font-medium text-white">{verificationDetail.pid ?? "—"}</p>
          </div>
        </div>
        <p className="text-sm text-emerald-50/90">
          Verification refreshed from the selected plist after the approved action.
        </p>
        {structuredResult?.verification.length ? (
          <ul className="list-disc space-y-1 pl-4 text-sm text-emerald-50/90">
            {structuredResult.verification.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ul>
        ) : null}
      </div>
    ) : (
      <p className="text-sm text-slate-300">
        Verification appears here after the approved action refreshes the selected job.
      </p>
    )

    return [
      {
        id: "summary",
        title: "Summary",
        eyebrow: "1. Understand the job",
        state: structuredResult ? "done" : "active",
        body: summaryBody,
      },
      {
        id: "preview",
        title: "Preview",
        eyebrow: "2. Review the change",
        state: activeAction === "proposal" ? (actionPreview ? "done" : "active") : "idle",
        body: previewBody,
      },
      {
        id: "approval",
        title: "Approval gate",
        eyebrow: "3. Require confirmation",
        state:
          activeAction === "proposal"
            ? approvalConfirmed
              ? "done"
              : "locked"
            : "idle",
        body: approvalBody,
      },
      {
        id: "apply",
        title: "Apply action",
        eyebrow: "4. Execute safely",
        state: appliedAction ? "done" : selectedJob?.source === "UserAgent" ? "ready" : "locked",
        body: applyBody,
      },
      {
        id: "verify",
        title: "Verification",
        eyebrow: "5. Confirm outcome",
        state: verificationDetail ? "done" : appliedAction ? "active" : "idle",
        body: verifyBody,
      },
    ]
  }, [
    actionPreview,
    activeAction,
    appliedAction,
    approvalConfirmed,
    jobDetail,
    selectedJob,
    structuredResult,
    verificationDetail,
    running,
  ])

  const timelineStateLabel = (state: TimelineStepState) => {
    if (state === "done") return "Complete"
    if (state === "active") return "Active"
    if (state === "ready") return "Ready"
    if (state === "locked") return "Needs approval"
    return "Idle"
  }

  const timelineProgress = useMemo(() => {
    const completed = timelineSteps.filter((step) => step.state === "done").length
    const next = timelineSteps.find((step) => step.state !== "done") ?? timelineSteps[timelineSteps.length - 1]
    return {
      completed,
      total: timelineSteps.length,
      next,
    }
  }, [timelineSteps])
  const runtimeReady = summary?.configured === true
  const runtimeBlockedReason =
    summary && !summary.configured
      ? summary.readiness_checks.find((check) => check.status === "missing")?.detail ??
        summary.details[0] ??
        "Complete the selected provider settings."
      : null
  const runtimeHowToSteps = [
    {
      title: "Choose a local provider",
      detail:
        providerOptions.find((option) => option.value === provider)?.label ??
        "Select Ollama, llama.cpp / yama.cpp, or a custom local CLI.",
    },
    {
      title: "Fill the required fields",
      detail: runtimeBlockedReason ?? "Enter the local executable, model, or prompt mode settings.",
    },
    {
      title: "Save and smoke test",
      detail:
        runtimeReady
          ? "Save Runtime writes the config file. Smoke Test Runtime should return a short success response."
          : "Save Runtime stays disabled until the configuration is complete.",
    },
    {
      title: "Run the prompt",
      detail:
        "Pick Summarize, Plan fix, or Propose command, then Run Prompt. Proposals still require approval unless semi-autonomous mode is enabled.",
    },
  ]

  const updateSettings = (patch: Partial<AgentRuntimeSettings>) => {
    setSettings((current) => {
      if (!current) return current
      return { ...current, ...patch }
    })
  }

  const handleSave = async () => {
    if (!settings) return
    setSaving(true)
    setError(null)
    try {
      const saved = await saveAgentRuntimeSettings(settings)
      setSettings(saved)
      const loadedSummary = await getAgentRuntimeSummary()
      setSummary(loadedSummary)
    } catch (e) {
      setError(String(e))
    } finally {
      setSaving(false)
    }
  }

  const handleRun = async () => {
    if (!settings || !runtimeReady) return
    setRunning(true)
    setError(null)
    setResponse("")
    setCommandLine("")
    setStructuredResult(null)
    setAppliedAction(null)
    setVerificationDetail(null)
    try {
      const result = await runAgentPrompt({
        prompt,
        job_context: buildDetailedJobContext(jobDetail) ?? jobContext,
        mode,
      })
      const parsed = extractJsonObject(result.response)
      setResponse(result.response || "(no output)")
      setCommandLine(result.command_line)
      setStructuredResult(parsed)
      setConversation((current) => [
        {
          id: `${Date.now()}-${current.length}`,
          action: activeAction,
          prompt,
          summary: parsed?.summary ?? "Unstructured response",
          response: result.response || "(no output)",
          commandProposal: parsed?.command_proposal ?? null,
        },
        ...current,
      ].slice(0, 8))
      setApprovalConfirmed(false)
      if (parsed && autoApplySafeActions && isSafeAutoApplyProposal(selectedJob, parsed)) {
        setApprovalConfirmed(true)
        await applyStructuredAction(parsed, true)
      }
    } catch (e) {
      setError(String(e))
    } finally {
      setRunning(false)
    }
  }

  const handleSmokeTest = async () => {
    if (!settings || !runtimeReady) return
    setSmokeRunning(true)
    setSmokeResult(null)
    setError(null)
    try {
      const result = await runAgentPrompt({
        prompt: "Reply with exactly: runtime ok",
        job_context: null,
        mode: "smoke",
      })
      setSmokeResult(result.response || "(no output)")
    } catch (e) {
      setError(String(e))
    } finally {
      setSmokeRunning(false)
    }
  }

  return (
    <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-5 shadow-2xl shadow-black/30 backdrop-blur-xl">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
            Local agent
          </p>
          <h3 className="mt-1 text-lg font-semibold text-white">Embedded model routing</h3>
        </div>
        <Badge
          className={
            settings?.provider
              ? "border-white/10 bg-white/5 text-slate-100 hover:bg-white/5"
              : "border-white/10 bg-white/5 text-slate-400 hover:bg-white/5"
          }
        >
          {providerOptions.find((option) => option.value === provider)?.label ?? "Loading"}
        </Badge>
      </div>

      {summary && (
        <div
          className={[
            "mt-3 rounded-2xl border p-3 text-sm",
            summary.configured
              ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-100"
              : "border-amber-500/20 bg-amber-500/10 text-amber-100",
          ].join(" ")}
        >
          <p className="font-medium">
            {summary.configured ? "Ready" : "Needs configuration"}
          </p>
          <p className="mt-1 text-xs text-inherit/80">
            {summary.details.join(" • ")}
          </p>
          {summary.readiness_checks.length > 0 && (
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {summary.readiness_checks.map((check) => (
                <div
                  key={`${check.label}-${check.detail}`}
                  className="rounded-xl border border-white/10 bg-black/15 p-2"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[10px] uppercase tracking-[0.2em] text-inherit/70">
                      {check.label}
                    </span>
                    <span
                      className={[
                        "rounded-full px-2 py-0.5 text-[10px] uppercase tracking-[0.18em]",
                        check.status === "ready"
                          ? "bg-emerald-400/15 text-emerald-50"
                          : "bg-amber-300/15 text-amber-50",
                      ].join(" ")}
                    >
                      {check.status}
                    </span>
                  </div>
                  <p className="mt-1 truncate text-xs text-inherit/85">{check.detail}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-4">
        <div className="rounded-3xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                How it works
              </p>
              <h4 className="mt-1 text-base font-semibold text-white">
                Configure a local model tool, then test it before prompting
              </h4>
            </div>
            <Badge className="border-white/10 bg-white/5 text-slate-100 hover:bg-white/5">
              Local only
            </Badge>
          </div>
          <div className="mt-3 grid gap-2">
            {runtimeHowToSteps.map((step, index) => (
              <div key={step.title} className="rounded-2xl border border-white/10 bg-black/10 p-3">
                <div className="flex items-start gap-3">
                  <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-cyan-400/15 text-xs font-semibold text-cyan-50">
                    {index + 1}
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-white">{step.title}</p>
                    <p className="mt-1 text-xs leading-5 text-slate-300">{step.detail}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs leading-5 text-slate-400">
            The local agent does not call a remote chat API. It launches the executable you configure in this panel and writes the runtime settings to disk so they persist across launches.
          </p>
        </div>

        <div className="rounded-3xl border border-sky-400/15 bg-sky-400/10 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-sky-100/70">
                Proactive insights
              </p>
              <h4 className="mt-1 text-base font-semibold text-white">
                Local job signals before prompting
              </h4>
            </div>
            <Badge className="border-sky-300/20 bg-sky-300/10 text-sky-50 hover:bg-sky-300/10">
              {proactiveInsights.length} signals
            </Badge>
          </div>
          <ul className="mt-3 grid gap-2 text-sm text-sky-50/90">
            {proactiveInsights.map((insight) => (
              <li key={insight} className="rounded-xl border border-white/10 bg-black/15 p-2">
                {insight}
              </li>
            ))}
          </ul>
        </div>

        <div className="grid gap-2 md:grid-cols-3">
          {(
            [
              {
                id: "summary",
                title: "Summarize",
                description: "Explain the selected job and its current state.",
              },
              {
                id: "remediation",
                title: "Plan fix",
                description: "Generate a safe step-by-step remediation plan.",
              },
              {
                id: "proposal",
                title: "Propose command",
                description: "Draft the launchctl command with safety notes.",
              },
            ] as Array<{ id: AgentAction; title: string; description: string }>
          ).map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => {
                setActiveAction(item.id)
                setPrompt(actionPrompt(item.id, mode, selectedJob))
                setStructuredResult(null)
                setAppliedAction(null)
                setVerificationDetail(null)
                setApprovalConfirmed(false)
              }}
              className={[
                "rounded-2xl border p-3 text-left transition",
                activeAction === item.id
                  ? "border-cyan-400/50 bg-cyan-400/10"
                  : "border-white/10 bg-white/5 hover:bg-white/10",
              ].join(" ")}
            >
              <div className="text-sm font-medium text-white">{item.title}</div>
              <p className="mt-1 text-xs leading-5 text-slate-300">{item.description}</p>
            </button>
          ))}
        </div>

        <div className="grid gap-1.5">
          <Label>Provider</Label>
          <Select
            value={provider}
            onValueChange={(value) =>
              updateSettings({ provider: value as AgentRuntimeProvider })
            }
          >
            <SelectTrigger>
              <SelectValue placeholder="Select provider" />
            </SelectTrigger>
            <SelectContent>
              {providerOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="grid gap-1.5">
          <Label>System prompt</Label>
          <textarea
            value={settings?.system_prompt ?? ""}
            onChange={(e) => updateSettings({ system_prompt: e.target.value })}
            className="min-h-28 rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
            placeholder="System prompt for local inference..."
          />
        </div>

        {provider === "LlamaCpp" && (
          <>
            <div className="grid gap-1.5">
              <Label>Executable path</Label>
              <Input
                value={settings?.llama_cpp_executable_path ?? ""}
                onChange={(e) =>
                  updateSettings({ llama_cpp_executable_path: e.target.value })
                }
                placeholder="/Users/you/path/to/llama-cli"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Model path</Label>
              <Input
                value={settings?.llama_cpp_model_path ?? ""}
                onChange={(e) => updateSettings({ llama_cpp_model_path: e.target.value })}
                placeholder="/Users/you/models/model.gguf"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Model flag</Label>
                <Input
                  value={settings?.llama_cpp_model_flag ?? ""}
                  onChange={(e) => updateSettings({ llama_cpp_model_flag: e.target.value })}
                  placeholder="-m"
                />
              </div>
              <div className="grid gap-1.5">
                <Label>Prompt flag</Label>
                <Input
                  value={settings?.llama_cpp_prompt_flag ?? ""}
                  onChange={(e) => updateSettings({ llama_cpp_prompt_flag: e.target.value })}
                  placeholder="-p"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label>Extra args</Label>
              <Input
                value={settings?.llama_cpp_extra_args ?? ""}
                onChange={(e) => updateSettings({ llama_cpp_extra_args: e.target.value })}
                placeholder="--ctx-size 4096 --temp 0.2"
              />
            </div>
          </>
        )}

        {provider === "Ollama" && (
          <>
            <div className="grid gap-1.5">
              <Label>Executable path</Label>
              <Input
                value={settings?.ollama_executable_path ?? ""}
                onChange={(e) =>
                  updateSettings({ ollama_executable_path: e.target.value })
                }
                placeholder="ollama"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Model</Label>
              <Input
                value={settings?.ollama_model ?? ""}
                onChange={(e) => updateSettings({ ollama_model: e.target.value })}
                placeholder="llama3.2:1b"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Host</Label>
              <Input
                value={settings?.ollama_host ?? ""}
                onChange={(e) => updateSettings({ ollama_host: e.target.value })}
                placeholder="http://127.0.0.1:11434"
              />
            </div>
          </>
        )}

        {provider === "LocalCli" && (
          <>
            <div className="grid gap-1.5">
              <Label>Executable path</Label>
              <Input
                value={settings?.local_cli_executable_path ?? ""}
                onChange={(e) =>
                  updateSettings({ local_cli_executable_path: e.target.value })
                }
                placeholder="/Users/you/bin/local-agent"
              />
            </div>
            <div className="grid gap-1.5">
              <Label>Args template</Label>
              <Input
                value={settings?.local_cli_args_template ?? ""}
                onChange={(e) =>
                  updateSettings({ local_cli_args_template: e.target.value })
                }
                placeholder="--model small --mode assistant"
              />
              <p className="text-xs text-slate-400">
                Use <code>{`{prompt}`}</code> and <code>{`{context}`}</code> placeholders if the CLI supports them.
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label>Prompt mode</Label>
                <Select
                  value={settings?.local_cli_prompt_mode ?? "Stdin"}
                  onValueChange={(value) =>
                    updateSettings({ local_cli_prompt_mode: value as PromptInputMode })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {promptModeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label>Prompt argument</Label>
                <Input
                  value={settings?.local_cli_prompt_argument ?? ""}
                  onChange={(e) =>
                    updateSettings({ local_cli_prompt_argument: e.target.value })
                  }
                  placeholder="--prompt"
                />
              </div>
            </div>
          </>
        )}

        <label className="flex items-start gap-3 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-slate-200">
          <input
            type="checkbox"
            checked={autoApplySafeActions}
            onChange={(e) => setAutoApplySafeActions(e.target.checked)}
            className="mt-1 h-4 w-4 rounded border-white/20 bg-slate-950 text-cyan-500 focus:ring-cyan-400"
          />
          <span className="leading-6">
            Semi-autonomous mode: auto-apply safe user-agent start or kickstart proposals. Stop, restart, disable, bootout, and system-owned jobs still require manual review.
          </span>
        </label>

        <div className="flex flex-wrap gap-2">
          <Button
            onClick={handleSave}
            disabled={saving || !settings}
            className="min-w-32 bg-cyan-500 text-slate-950 hover:bg-cyan-400"
          >
            {saving ? "Saving..." : "Save Runtime"}
          </Button>
          <Button
            variant="outline"
            onClick={handleRun}
            disabled={
              running ||
              !settings ||
              !runtimeReady ||
              (activeAction === "proposal" && !approvalConfirmed && !autoApplySafeActions)
            }
            className="min-w-36 border-white/10 bg-white/5 text-slate-100 hover:bg-white/10"
          >
            {running
              ? "Running..."
              : !runtimeReady
                ? "Configure runtime"
              : activeAction === "proposal" && !approvalConfirmed && !autoApplySafeActions
                ? "Approve to run"
                : "Run Prompt"}
          </Button>
          <Button
            variant="outline"
            onClick={handleSmokeTest}
            disabled={smokeRunning || !settings || !runtimeReady}
            className="min-w-44 border-cyan-400/20 bg-cyan-400/10 text-cyan-50 hover:bg-cyan-400/20"
          >
            {smokeRunning ? "Testing..." : "Smoke Test Runtime"}
          </Button>
        </div>
        {runtimeBlockedReason && (
          <p className="text-xs text-amber-100/80">{runtimeBlockedReason}</p>
        )}
        <div
          className={[
            "rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-3 text-sm text-cyan-50 transition-[opacity,transform] duration-150",
            smokeResult ? "opacity-100 translate-y-0" : "min-h-16 opacity-0 translate-y-1 pointer-events-none",
          ].join(" ")}
        >
          <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-100/70">
            Smoke result
          </p>
          <p className="mt-1 font-mono text-xs leading-5">
            {smokeResult ?? "Waiting for a smoke test result."}
          </p>
        </div>

        <div className="rounded-3xl border border-white/10 bg-white/5 p-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                Job timeline
              </p>
              <h4 className="mt-1 text-base font-semibold text-white">
                Summary, preview, approval, apply, verify
              </h4>
            </div>
            {selectedJob && (
              <Badge className="border-white/10 bg-white/5 text-slate-100 hover:bg-white/5">
                {selectedJob.source === "UserAgent" ? "Mutable" : "Read-only"}
              </Badge>
            )}
          </div>

          <div className="mt-4 grid gap-2 rounded-2xl border border-white/10 bg-black/10 p-3 sm:grid-cols-[repeat(2,minmax(0,1fr))_auto]">
            <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                Progress
              </p>
              <p className="mt-1 text-sm font-medium text-white">
                {timelineProgress.completed}/{timelineProgress.total} stages complete
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                Next up
              </p>
              <p className="mt-1 text-sm font-medium text-white">
                {timelineProgress.next.title}
              </p>
            </div>
            <div className="rounded-xl border border-white/10 bg-white/5 px-3 py-2">
              <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                Blocker
              </p>
              <p className="mt-1 text-sm font-medium text-white">
                {timelineProgress.next.state === "locked"
                  ? "Approval required"
                  : timelineProgress.next.state === "ready"
                    ? "Execution ready"
                    : timelineProgress.next.state === "done"
                      ? "None"
                      : "Awaiting input"}
              </p>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {timelineSteps.map((step) => (
              <button
                key={`${step.id}-chip`}
                type="button"
                onClick={() => {
                  if (step.id === "summary") {
                    setActiveAction("summary")
                    setPrompt(defaultPrompt(mode, selectedJob))
                  }
                  if (step.id === "preview" || step.id === "approval" || step.id === "apply" || step.id === "verify") {
                    setActiveAction("proposal")
                    setPrompt(actionPrompt("proposal", mode, selectedJob))
                  }
                }}
                className={[
                  "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs text-left transition",
                  step.id === activeAction
                    ? "ring-1 ring-cyan-400/40"
                    : "hover:bg-white/10",
                  step.state === "done"
                    ? "border-emerald-400/25 bg-emerald-400/10 text-emerald-100"
                    : step.state === "active"
                      ? "border-cyan-400/25 bg-cyan-400/10 text-cyan-100"
                      : step.state === "ready"
                        ? "border-sky-400/25 bg-sky-400/10 text-sky-100"
                        : step.state === "locked"
                          ? "border-amber-400/25 bg-amber-400/10 text-amber-100"
                          : "border-white/10 bg-white/5 text-slate-300",
                ].join(" ")}
              >
                <span className="font-semibold">{step.title}</span>
                <span className="rounded-full border border-white/10 bg-black/20 px-2 py-0.5 text-[10px] uppercase tracking-[0.22em]">
                  {timelineStateLabel(step.state)}
                </span>
              </button>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            {timelineSteps.map((step, index) => (
              <div key={step.id} className="grid gap-3 md:grid-cols-[auto_minmax(0,1fr)]">
                <div className="flex items-start gap-3 md:flex-col md:items-center">
                  <div
                    className={[
                      "flex h-7 w-7 items-center justify-center rounded-full border text-[11px] font-semibold",
                      step.state === "done"
                        ? "border-emerald-400/40 bg-emerald-400/15 text-emerald-200"
                        : step.state === "active"
                          ? "border-cyan-400/50 bg-cyan-400/15 text-cyan-200"
                          : step.state === "ready"
                            ? "border-sky-400/40 bg-sky-400/15 text-sky-200"
                            : step.state === "locked"
                              ? "border-amber-400/40 bg-amber-400/15 text-amber-200"
                              : "border-white/10 bg-white/5 text-slate-400",
                    ].join(" ")}
                  >
                    {index + 1}
                  </div>
                  {index < timelineSteps.length - 1 && (
                    <div className="hidden h-full w-px bg-white/10 md:block" />
                  )}
                </div>

                <div
                  className={[
                    "rounded-2xl border p-3.5",
                    step.state === "done"
                      ? "border-emerald-500/20 bg-emerald-500/10"
                      : step.state === "active"
                        ? "border-cyan-500/20 bg-cyan-500/10"
                        : step.state === "ready"
                          ? "border-sky-500/20 bg-sky-500/10"
                          : step.state === "locked"
                            ? "border-amber-500/20 bg-amber-500/10"
                            : "border-white/10 bg-black/10",
                  ].join(" ")}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-[11px] uppercase tracking-[0.24em] text-slate-400">
                        {step.eyebrow}
                      </p>
                      <h5 className="mt-1 text-sm font-medium text-white">{step.title}</h5>
                    </div>
                    <Badge
                      className={[
                        "hover:bg-white/5",
                        step.state === "done"
                          ? "border-emerald-300/20 bg-emerald-300/10 text-emerald-50"
                          : step.state === "active"
                            ? "border-cyan-300/20 bg-cyan-300/10 text-cyan-50"
                            : step.state === "ready"
                              ? "border-sky-300/20 bg-sky-300/10 text-sky-50"
                              : step.state === "locked"
                                ? "border-amber-300/20 bg-amber-300/10 text-amber-50"
                                : "border-white/10 bg-white/5 text-slate-300",
                      ].join(" ")}
                    >
                      {timelineStateLabel(step.state)}
                    </Badge>
                  </div>
                  <div className="mt-2 text-sm">{step.body}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {error && (
          <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
            {error}
          </div>
        )}

        {conversation.length > 0 && (
          <div className="rounded-3xl border border-white/10 bg-white/5 p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                  Conversation history
                </p>
                <h4 className="mt-1 text-base font-semibold text-white">
                  Last local assistant turns
                </h4>
              </div>
              <Button
                type="button"
                variant="outline"
                onClick={() => setConversation([])}
                className="border-white/10 bg-white/5 text-slate-100 hover:bg-white/10"
              >
                Clear History
              </Button>
            </div>
            <div className="mt-3 grid gap-2">
              {conversation.map((entry) => (
                <div key={entry.id} className="rounded-2xl border border-white/10 bg-black/15 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs uppercase tracking-[0.22em] text-cyan-100/70">
                      {entry.action}
                    </span>
                    {entry.commandProposal && (
                      <span className="rounded-full border border-amber-300/20 bg-amber-300/10 px-2 py-0.5 text-[10px] uppercase tracking-[0.18em] text-amber-50">
                        Command proposed
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-sm font-medium text-white">{entry.summary}</p>
                  <details className="mt-2 text-xs text-slate-300">
                    <summary className="cursor-pointer text-cyan-200">Show prompt and response</summary>
                    <CopyableCodeBlock
                      text={`Prompt:\n${entry.prompt}\n\nResponse:\n${entry.response}`}
                      copyLabel="Copy conversation details"
                      className="mt-2"
                    >
                      <pre className="whitespace-pre-wrap rounded-xl border border-white/10 bg-slate-950/70 p-3 font-mono leading-5">
                        {`Prompt:\n${entry.prompt}\n\nResponse:\n${entry.response}`}
                      </pre>
                    </CopyableCodeBlock>
                  </details>
                </div>
              ))}
            </div>
          </div>
        )}

        <details className="group rounded-3xl border border-white/10 bg-white/5 p-4">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
            <div>
              <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                Audit trail
              </p>
              <h4 className="mt-1 text-base font-semibold text-white">
                Prompt, response, and context snapshots
              </h4>
            </div>
            <span className="rounded-full border border-white/10 bg-black/20 px-3 py-1 text-xs text-slate-300 transition group-open:text-white">
              Expand
            </span>
          </summary>

          <div className="mt-4 space-y-3">
            <div className="space-y-3 rounded-2xl border border-white/10 bg-slate-950/70 p-3">
              <div className="flex items-center justify-between gap-3">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                  Prompt
                </p>
                <button
                  type="button"
                  className="text-xs text-cyan-300 hover:text-cyan-200"
                  onClick={() => {
                    setActiveAction("summary")
                    setPrompt(defaultPrompt(mode, selectedJob))
                  }}
                >
                  Reset
                </button>
              </div>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="min-h-32 w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground shadow-sm outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
                placeholder="Ask about the selected launchd job..."
              />
              {jobContext && (
                <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-slate-300">
                  <p className="mb-2 uppercase tracking-[0.24em] text-slate-500">
                    Selected job context
                  </p>
                  <CopyableCodeBlock text={jobContext} copyLabel="Copy selected job context">
                    <pre className="whitespace-pre-wrap font-mono leading-5">{jobContext}</pre>
                  </CopyableCodeBlock>
                </div>
              )}
              {jobDetail && (
                <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-slate-300">
                  <p className="mb-2 uppercase tracking-[0.24em] text-slate-500">
                    Full plist context
                  </p>
                  <CopyableCodeBlock
                    text={buildDetailedJobContext(jobDetail) ?? ""}
                    copyLabel="Copy full plist context"
                  >
                    <pre className="whitespace-pre-wrap font-mono leading-5">
                      {buildDetailedJobContext(jobDetail)}
                    </pre>
                  </CopyableCodeBlock>
                </div>
              )}
              {commandLine && (
                <div className="rounded-xl border border-white/10 bg-black/20 p-3 text-xs text-slate-300">
                  <p className="mb-2 uppercase tracking-[0.24em] text-slate-500">
                    Last command
                  </p>
                  <CopyableCodeBlock text={commandLine} copyLabel="Copy last command">
                    <pre className="whitespace-pre-wrap font-mono leading-5">{commandLine}</pre>
                  </CopyableCodeBlock>
                </div>
              )}
            </div>

            {structuredResult && (
              <div className="space-y-3 rounded-2xl border border-cyan-500/20 bg-cyan-500/10 p-3 text-sm text-cyan-50">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-cyan-200">
                    Structured result
                  </p>
                  <p className="mt-1 font-medium">{structuredResult.summary}</p>
                </div>
                <div className="grid gap-2 md:grid-cols-2">
                  <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-cyan-200">
                      Risks
                    </p>
                    {structuredResult.risks.length > 0 ? (
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-sm">
                        {structuredResult.risks.map((risk) => (
                          <li key={risk}>{risk}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-cyan-50/80">No major risks identified.</p>
                    )}
                  </div>
                  <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-cyan-200">
                      Verification
                    </p>
                    {structuredResult.verification.length > 0 ? (
                      <ul className="mt-2 list-disc space-y-1 pl-4 text-sm">
                        {structuredResult.verification.map((step) => (
                          <li key={step}>{step}</li>
                        ))}
                      </ul>
                    ) : (
                      <p className="mt-2 text-sm text-cyan-50/80">No verification steps returned.</p>
                    )}
                  </div>
                </div>
                <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                  <p className="text-xs uppercase tracking-[0.22em] text-cyan-200">
                    Next step
                  </p>
                  <p className="mt-1 text-sm">{structuredResult.recommended_next_step}</p>
                </div>
                {structuredResult.command_proposal && (
                  <div className="rounded-lg border border-white/10 bg-black/20 p-3">
                    <p className="text-xs uppercase tracking-[0.22em] text-cyan-200">
                      Command proposal
                    </p>
                    <CopyableCodeBlock
                      text={structuredResult.command_proposal}
                      copyLabel="Copy command proposal"
                      className="mt-2"
                    >
                      <pre className="whitespace-pre-wrap font-mono text-xs leading-5 text-cyan-50">
                        {structuredResult.command_proposal}
                      </pre>
                    </CopyableCodeBlock>
                  </div>
                )}
                <div className="flex items-center justify-between rounded-lg border border-white/10 bg-black/20 p-3 text-xs text-cyan-100">
                  <span>Approval required: {structuredResult.approval_required ? "yes" : "no"}</span>
                  <span>Action: {structuredResult.action}</span>
                </div>
              </div>
            )}

            {appliedAction && (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                <p className="mb-1 text-xs uppercase tracking-[0.24em] text-emerald-300">
                  Applied
                </p>
                <p className="font-mono text-xs leading-5">{appliedAction}</p>
              </div>
            )}

            {response && (
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                <p className="mb-2 text-xs uppercase tracking-[0.24em] text-emerald-300">
                  Model response
                </p>
                <CopyableCodeBlock text={response} copyLabel="Copy model response">
                  <pre className="whitespace-pre-wrap font-mono leading-5">{response}</pre>
                </CopyableCodeBlock>
              </div>
            )}
          </div>
        </details>
      </div>
    </div>
  )
}
