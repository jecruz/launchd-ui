import { useCallback, useEffect, useMemo, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { hide as hideApp, show as showApp, setDockVisibility } from "@tauri-apps/api/app"
import { getCurrentWindow } from "@tauri-apps/api/window"
import { ArrowUpRight, Bot, Layers3, Plus, RefreshCw, Shield, Sparkles, TerminalSquare, Activity } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { JobDetail } from "@/components/JobDetail"
import { JobForm } from "@/components/JobForm"
import { JobList } from "@/components/JobList"
import { SearchBar } from "@/components/SearchBar"
import { AgentPanel } from "@/components/AgentPanel"
import { useJobs } from "@/hooks/useJobs"
import {
  createJob,
  deleteJob,
  kickstartJob,
  revealInFinder,
  restartJob,
  saveJob,
  startJob,
  stopJob,
} from "@/lib/invoke"
import type { JobListEntry, LaunchdJob, PlistConfig } from "@/types"

const TRAY_COMMAND_EVENT = "launchd-ui:command"

type AgentMode = "copilot" | "approval" | "assistant"

type ModeCard = {
  id: AgentMode
  title: string
  eyebrow: string
  description: string
}

const modeCards: ModeCard[] = [
  {
    id: "copilot",
    title: "Copilot Mode",
    eyebrow: "Guide-first",
    description:
      "The agent explains state, proposes actions, and waits for approval before it mutates anything.",
  },
  {
    id: "approval",
    title: "Approval Mode",
    eyebrow: "Safe automation",
    description:
      "Safe user-agent actions can run automatically while destructive operations still pause for confirmation.",
  },
  {
    id: "assistant",
    title: "Full Assistant Mode",
    eyebrow: "Conversational",
    description:
      "The UI becomes a command surface with natural language, proactive insights, and quick job actions.",
  },
]

function ModeBadge({ mode }: { mode: AgentMode }) {
  const card = modeCards.find((item) => item.id === mode)!
  return (
    <Badge className="border-white/10 bg-white/5 text-slate-100 hover:bg-white/5">
      {card.title}
    </Badge>
  )
}

function App() {
  const {
    jobs,
    filteredJobs,
    loading,
    error,
    search,
    setSearch,
    sourceFilter,
    setSourceFilter,
    refresh,
  } = useJobs()

  const [selectedPlistPath, setSelectedPlistPath] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const [editingJob, setEditingJob] = useState<LaunchdJob | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<JobListEntry | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [agentMode, setAgentMode] = useState<AgentMode>("approval")

  const selectedJob = useMemo(
    () => jobs.find((job) => job.plist_path === selectedPlistPath) ?? null,
    [jobs, selectedPlistPath]
  )

  const handleAction = useCallback(
    async (action: () => Promise<void>) => {
      setActionError(null)
      try {
        await action()
        await refresh()
      } catch (e) {
        setActionError(String(e))
      }
    },
    [refresh]
  )

  const openControlCenter = useCallback(async () => {
    const currentWindow = getCurrentWindow()
    await showApp().catch(() => undefined)
    await setDockVisibility(false).catch(() => undefined)
    await currentWindow.show().catch(() => undefined)
    await currentWindow.unminimize().catch(() => undefined)
    await currentWindow.setFocus().catch(() => undefined)
  }, [])

  useEffect(() => {
    document.documentElement.classList.add("dark")

    const currentWindow = getCurrentWindow()
    let unlistenCommand: (() => void) | undefined
    let unlistenClose: (() => void) | undefined

    const bootstrap = async () => {
      await setDockVisibility(false).catch(() => undefined)
      await hideApp().catch(() => undefined)
      await currentWindow.hide().catch(() => undefined)

      unlistenClose = await currentWindow.onCloseRequested(async (event) => {
        event.preventDefault()
        await hideApp().catch(() => undefined)
        await currentWindow.hide().catch(() => undefined)
      })

      unlistenCommand = await listen<string>(TRAY_COMMAND_EVENT, async (event) => {
        if (event.payload === "open") {
          await openControlCenter()
          return
        }

        if (event.payload === "refresh") {
          await openControlCenter()
          await refresh()
          return
        }

        if (event.payload === "new-agent") {
          await openControlCenter()
          setEditingJob(null)
          setFormKey((k) => k + 1)
          setFormOpen(true)
        }
      })
    }

    void bootstrap()

    return () => {
      unlistenCommand?.()
      unlistenClose?.()
    }
  }, [openControlCenter, refresh])

  const handleSelect = useCallback((job: JobListEntry) => {
    setSelectedPlistPath(job.plist_path)
    setDetailOpen(true)
  }, [])

  const handleEdit = useCallback((job: LaunchdJob) => {
    setEditingJob(job)
    setFormKey((k) => k + 1)
    setFormOpen(true)
    setDetailOpen(false)
  }, [])

  const handleSave = useCallback(
    async (config: PlistConfig, plistPath?: string) => {
      if (plistPath) {
        await saveJob(plistPath, config)
      } else {
        await createJob(config.label, config)
      }
      await refresh()
    },
    [refresh]
  )

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return
    await handleAction(() => deleteJob(deleteTarget.plist_path, deleteTarget.label))
    setDeleteTarget(null)
  }, [deleteTarget, handleAction])

  const runningCount = jobs.filter((job) => job.status === "Running").length
  const loadedCount = jobs.filter((job) => job.status === "Loaded").length
  const userAgentCount = jobs.filter((job) => job.source === "UserAgent").length

  const modeCard = modeCards.find((item) => item.id === agentMode) ?? modeCards[1]

  return (
    <div className="relative min-h-screen overflow-hidden bg-[radial-gradient(circle_at_top_left,_rgba(45,212,191,0.16),_transparent_34%),radial-gradient(circle_at_top_right,_rgba(59,130,246,0.14),_transparent_28%),linear-gradient(180deg,_#020617_0%,_#0f172a_100%)] text-foreground">
      <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(rgba(148,163,184,0.05)_1px,transparent_1px),linear-gradient(90deg,rgba(148,163,184,0.05)_1px,transparent_1px)] bg-[size:24px_24px] [mask-image:linear-gradient(180deg,rgba(0,0,0,0.55),transparent_88%)]" />

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col px-4 py-4 sm:px-6 lg:px-8">
        <header className="rounded-3xl border border-white/10 bg-slate-950/70 px-5 py-4 shadow-2xl shadow-black/30 backdrop-blur-xl">
          <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge className="border-emerald-400/30 bg-emerald-400/10 text-emerald-200 hover:bg-emerald-400/10">
                  Menu bar
                </Badge>
                <Badge variant="outline" className="border-white/10 text-slate-300">
                  launchd control surface
                </Badge>
                <ModeBadge mode={agentMode} />
              </div>

              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Launch Control
                </h1>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
                  A tray-first macOS control center for launchd jobs with agent-driven
                  workflows, local reasoning hooks, and a deterministic launchctl
                  executor under the hood.
                </p>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="border-white/10 bg-white/5 text-slate-100 hover:bg-white/10"
                onClick={openControlCenter}
              >
                Open Panel
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="border-white/10 bg-white/5 text-slate-100 hover:bg-white/10"
                onClick={refresh}
              >
                <RefreshCw className="mr-2 h-4 w-4" />
                Refresh
              </Button>
              <Button
                size="sm"
                className="bg-emerald-500 text-slate-950 hover:bg-emerald-400"
                onClick={() => {
                  setEditingJob(null)
                  setFormKey((k) => k + 1)
                  setFormOpen(true)
                }}
              >
                <Plus className="mr-2 h-4 w-4" />
                New Agent
              </Button>
            </div>
          </div>
        </header>

        <main className="mt-4 flex flex-1 flex-col gap-4">
          <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
            <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-4 shadow-lg shadow-black/20 backdrop-blur-xl">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                    Active
                  </p>
                  <div className="mt-2 text-3xl font-semibold text-white">
                    {runningCount}
                  </div>
                </div>
                <div className="rounded-2xl bg-emerald-500/15 p-3 text-emerald-300">
                  <Activity className="h-5 w-5" />
                </div>
              </div>
              <p className="mt-3 text-sm text-slate-400">Jobs with a live PID.</p>
            </div>

            <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-4 shadow-lg shadow-black/20 backdrop-blur-xl">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                    Loaded
                  </p>
                  <div className="mt-2 text-3xl font-semibold text-white">
                    {loadedCount}
                  </div>
                </div>
                <div className="rounded-2xl bg-sky-500/15 p-3 text-sky-300">
                  <Layers3 className="h-5 w-5" />
                </div>
              </div>
              <p className="mt-3 text-sm text-slate-400">
                Registered with launchd but not running.
              </p>
            </div>

            <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-4 shadow-lg shadow-black/20 backdrop-blur-xl">
              <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                User Agents
              </p>
              <div className="mt-2 text-3xl font-semibold text-white">
                {userAgentCount}
              </div>
              <p className="mt-3 text-sm text-slate-400">
                Mutable jobs are controlled directly from the app.
              </p>
            </div>

            <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-4 shadow-lg shadow-black/20 backdrop-blur-xl">
              <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                Agent posture
              </p>
              <div className="mt-2 flex items-center gap-2 text-lg font-medium text-white">
                <Sparkles className="h-4 w-4 text-amber-300" />
                {modeCard.title}
              </div>
              <p className="mt-3 text-sm text-slate-400">{modeCard.eyebrow}</p>
            </div>
          </section>

          {(error || actionError) && (
            <div className="space-y-2">
              {error && (
                <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200 shadow-lg shadow-rose-950/20">
                  {error}
                </div>
              )}
              {actionError && (
                <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200 shadow-lg shadow-rose-950/20">
                  {actionError}
                </div>
              )}
            </div>
          )}

          <section className="grid flex-1 gap-4 xl:grid-cols-[minmax(0,1.75fr)_minmax(320px,0.95fr)]">
            <div className="overflow-hidden rounded-3xl border border-white/10 bg-slate-950/70 shadow-2xl shadow-black/30 backdrop-blur-xl">
              <div className="border-b border-white/10 px-5 py-4">
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                      Jobs
                    </p>
                    <h2 className="mt-1 text-lg font-semibold text-white">
                      Launchd jobs and agents
                    </h2>
                  </div>
                  <SearchBar
                    search={search}
                    onSearchChange={setSearch}
                    sourceFilter={sourceFilter}
                    onSourceFilterChange={setSourceFilter}
                  />
                </div>

                <div className="mt-4 grid gap-2 md:grid-cols-3">
                  {modeCards.map((mode) => (
                    <button
                      key={mode.id}
                      type="button"
                      onClick={() => setAgentMode(mode.id)}
                      className={[
                        "rounded-2xl border p-3 text-left transition",
                        agentMode === mode.id
                          ? "border-emerald-400/50 bg-emerald-400/10"
                          : "border-white/10 bg-white/5 hover:bg-white/10",
                      ].join(" ")}
                    >
                      <div className="text-xs uppercase tracking-[0.24em] text-slate-400">
                        {mode.eyebrow}
                      </div>
                      <div className="mt-1 font-medium text-white">{mode.title}</div>
                      <p className="mt-2 text-sm leading-5 text-slate-300">
                        {mode.description}
                      </p>
                    </button>
                  ))}
                </div>
              </div>

              <div className="p-3 sm:p-4">
                <JobList
                  jobs={filteredJobs}
                  loading={loading}
                  onStart={(job) => handleAction(() => startJob(job.plist_path))}
                  onStop={(job) => handleAction(() => stopJob(job.plist_path))}
                  onRestart={(job) => handleAction(() => restartJob(job.plist_path))}
                  onKickstart={(job) => handleAction(() => kickstartJob(job.label, job.plist_path))}
                  onDelete={(job) => setDeleteTarget(job)}
                  onSelect={handleSelect}
                  onRevealInFinder={(job) => revealInFinder(job.plist_path)}
                />
              </div>
            </div>

            <aside className="space-y-4">
              <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-5 shadow-2xl shadow-black/30 backdrop-blur-xl">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                      Focus
                    </p>
                    <h3 className="mt-1 text-lg font-semibold text-white">
                      {selectedJob ? selectedJob.label : "Select a job"}
                    </h3>
                  </div>
                  {selectedJob && (
                    <Badge
                      variant="outline"
                      className="border-white/10 bg-white/5 text-slate-200"
                    >
                      {selectedJob.source === "UserAgent" ? "User" : "Read-only"}
                    </Badge>
                  )}
                </div>

                {selectedJob ? (
                  <div className="mt-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                          Status
                        </p>
                        <p className="mt-1 text-base font-medium text-white">
                          {selectedJob.status}
                        </p>
                      </div>
                      <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                        <p className="text-xs uppercase tracking-[0.2em] text-slate-400">
                          PID
                        </p>
                        <p className="mt-1 text-base font-medium text-white">
                          {selectedJob.pid ?? "—"}
                        </p>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-slate-300">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-slate-400">Path</span>
                        <button
                          type="button"
                          className="inline-flex items-center gap-1 text-xs text-cyan-300 hover:text-cyan-200"
                          onClick={() => revealInFinder(selectedJob.plist_path)}
                        >
                          Reveal
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                      <p className="mt-2 break-all font-mono text-xs text-slate-200">
                        {selectedJob.plist_path}
                      </p>
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-white/10 bg-white/5 text-slate-100 hover:bg-white/10"
                        onClick={() => handleSelect(selectedJob)}
                      >
                        Open Details
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-white/10 bg-white/5 text-slate-100 hover:bg-white/10"
                        onClick={() => handleAction(() => kickstartJob(selectedJob.label, selectedJob.plist_path))}
                      >
                        Test Run
                      </Button>
                    </div>

                    <div className="rounded-2xl border border-emerald-500/20 bg-emerald-500/10 p-3 text-sm text-emerald-100">
                      {selectedJob.source === "UserAgent"
                        ? "This job is user-owned, so start, stop, restart, and delete actions are available."
                        : "This job is system-owned. The UI remains read-only and only exposes inspection actions."}
                    </div>
                  </div>
                ) : (
                  <div className="mt-4 rounded-2xl border border-dashed border-white/10 bg-white/5 p-4 text-sm text-slate-300">
                    Pick a job from the list to surface its plist, status, and quick
                    actions here.
                  </div>
                )}
              </div>

              <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-5 shadow-2xl shadow-black/30 backdrop-blur-xl">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                  Local model slot
                </p>
                <div className="mt-3 flex items-center gap-2 text-white">
                  <Bot className="h-4 w-4 text-cyan-300" />
                  <span className="font-medium">Lightweight embedded model</span>
                </div>
                <p className="mt-3 text-sm leading-6 text-slate-300">
                  The UI is structured for an on-device model that can summarize
                  launchd state, classify user requests, and drive the three agent
                  modes without shipping job data off the machine.
                </p>
                <div className="mt-4 rounded-2xl border border-white/10 bg-white/5 p-3 text-sm text-slate-300">
                  Planned flow: prompt bar, local inference, intent extraction, and
                  approval-aware execution.
                </div>
              </div>

              <AgentPanel mode={agentMode} selectedJob={selectedJob} onApplied={refresh} />

              <div className="rounded-3xl border border-white/10 bg-slate-900/70 p-5 shadow-2xl shadow-black/30 backdrop-blur-xl">
                <p className="text-xs uppercase tracking-[0.24em] text-slate-400">
                  Operating model
                </p>
                <ul className="mt-4 space-y-3 text-sm text-slate-300">
                  <li className="flex items-start gap-3">
                    <Shield className="mt-0.5 h-4 w-4 text-emerald-300" />
                    User agents are the only mutable target. System launch agents and daemons stay read-only.
                  </li>
                  <li className="flex items-start gap-3">
                    <TerminalSquare className="mt-0.5 h-4 w-4 text-sky-300" />
                    launchctl remains the deterministic executor. The agent only proposes or orchestrates.
                  </li>
                  <li className="flex items-start gap-3">
                    <Sparkles className="mt-0.5 h-4 w-4 text-amber-300" />
                    The tray icon owns open, refresh, and new-agent shortcuts for a real menu bar workflow.
                  </li>
                </ul>
              </div>
            </aside>
          </section>
        </main>

        <JobDetail
          plistPath={selectedPlistPath}
          open={detailOpen}
          onClose={() => setDetailOpen(false)}
          onEdit={handleEdit}
        />

        <JobForm
          key={formKey}
          open={formOpen}
          onClose={() => {
            setFormOpen(false)
            setEditingJob(null)
          }}
          onSave={handleSave}
          editingJob={editingJob}
        />

        <Dialog
          open={!!deleteTarget}
          onOpenChange={(isOpen) => !isOpen && setDeleteTarget(null)}
        >
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Delete Agent</DialogTitle>
            </DialogHeader>
            <p className="text-sm text-muted-foreground">
              Are you sure you want to delete{" "}
              <span className="font-mono font-medium text-foreground">
                {deleteTarget?.label}
              </span>
              ? This will stop the agent and remove its plist file.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
              <Button variant="destructive" onClick={handleDelete}>
                Delete
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  )
}

export default App
