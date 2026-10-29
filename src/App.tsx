import { createPreferenceWriter } from "@/lib/preference-writer"
import { fitWindow } from "@/lib/window-geometry"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { listen } from "@tauri-apps/api/event"
import { hide as hideApp, show as showApp, setDockVisibility } from "@tauri-apps/api/app"
import { getCurrentWindow, PhysicalPosition, PhysicalSize, availableMonitors } from "@tauri-apps/api/window"
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
import {
  createEmptyJobFormDraft,
  createJobFormDraftFromJob,
  createRepairJobFormDraftFromJob,
  JobForm,
} from "@/components/JobForm"
import { JobList } from "@/components/JobList"
import { SearchBar } from "@/components/SearchBar"
import { AgentPanel } from "@/components/AgentPanel"
import { useJobs } from "@/hooks/useJobs"
import { deriveHealthText } from "@/lib/health"
import {
  finishQuit,
  createJob,
  deleteJob,
  getAppPreferences,
  getJobDetail,
  kickstartJob,
  revealInFinder,
  restartJob,
  saveJob,
  saveAppPreferences,
  startJob,
  stopJob,
} from "@/lib/invoke"
import type {
  AppPreferences,
  JobListEntry,
  JobSortKey,
  LaunchdJob,
  PlistConfig,
  ServiceDiagnosis,
  SortDirection,
} from "@/types"

const TRAY_COMMAND_EVENT = "daemonic:command"

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

const bulkActionLabels: Record<"start" | "stop" | "restart" | "kickstart", string> = {
  start: "Start",
  stop: "Stop",
  restart: "Restart",
  kickstart: "Test Run",
}

const MIN_WINDOW_HEIGHT = 940

function ModeBadge({ mode }: { mode: AgentMode }) {
  const card = modeCards.find((item) => item.id === mode)!
  return (
    <Badge className="border-white/10 bg-white/5 text-slate-100 hover:bg-white/5">
      {card.title}
    </Badge>
  )
}

const defaultPreferences: AppPreferences = {
  search: "",
  source_filter: "All",
  group_filter: "All",
  sort_key: "health",
  sort_direction: "asc",
  agent_mode: "approval",
  detail_open: false,
  form_open: false,
  selected_plist_path: null,
  job_form_draft: null,
  window_geometry: null,
}

function normalizePreferences(preferences: AppPreferences | null): AppPreferences {
  if (!preferences) return defaultPreferences
  return {
    search: preferences.search ?? "",
    source_filter: preferences.source_filter ?? "All",
    group_filter: preferences.group_filter ?? "All",
    sort_key: preferences.sort_key ?? "health",
    sort_direction: preferences.sort_direction ?? "asc",
    agent_mode: preferences.agent_mode ?? "approval",
    detail_open: preferences.detail_open ?? false,
    form_open: preferences.form_open ?? false,
    selected_plist_path: preferences.selected_plist_path ?? null,
    job_form_draft: preferences.job_form_draft ?? null,
    window_geometry: preferences.window_geometry ?? null,
  }
}

function normalizeJobFormDraft(draft: AppPreferences["job_form_draft"]): AppPreferences["job_form_draft"] {
  if (!draft) return null
  return {
    ...draft,
    calendar_interval: draft.calendar_interval ?? null,
  }
}

function sameWindowGeometry(
  a: AppPreferences["window_geometry"],
  b: AppPreferences["window_geometry"]
) {
  if (a === b) return true
  if (!a || !b) return false
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}

function App() {
  const [preferences, setPreferences] = useState<AppPreferences>(defaultPreferences)
  const [preferencesReady, setPreferencesReady] = useState(false)
  const [preferencesWritable, setPreferencesWritable] = useState(false)
  const [preferenceError, setPreferenceError] = useState<string | null>(null)
  const preferenceWriter = useMemo(() => createPreferenceWriter(saveAppPreferences, setPreferenceError), [])
  const editGeneration = useRef(0)
  const formGeneration = useRef(0)
  const writableRef = useRef(preferencesWritable)
  writableRef.current = preferencesWritable
  const [reloadPreferences, setReloadPreferences] = useState(0)
  const [agentMode, setAgentMode] = useState<AgentMode>("approval")
  const {
    jobs,
    filteredJobs,
    loading,
    error,
    search,
    setSearch,
    sourceFilter,
    setSourceFilter,
    groupFilter,
    setGroupFilter,
    sortKey,
    setSortKey,
    sortDirection,
    setSortDirection,
    refresh,
  } = useJobs({
    search: preferences.search,
    sourceFilter: preferences.source_filter,
    groupFilter: preferences.group_filter,
    sortKey: preferences.sort_key as JobSortKey,
    sortDirection: preferences.sort_direction as SortDirection,
  })

  const [selectedPlistPath, setSelectedPlistPath] = useState<string | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)
  const [formOpen, setFormOpen] = useState(false)
  const [formKey, setFormKey] = useState(0)
  const [jobFormDraft, setJobFormDraft] = useState<AppPreferences["job_form_draft"]>(null)
  const [windowGeometry, setWindowGeometry] = useState<AppPreferences["window_geometry"]>(null)
  const [editingJob, setEditingJob] = useState<LaunchdJob | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<JobListEntry | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)

  const selectedJob = useMemo(
    () => jobs.find((job) => job.plist_path === selectedPlistPath) ?? null,
    [jobs, selectedPlistPath]
  )

  useEffect(() => {
    let cancelled = false

    const bootstrapPreferences = async () => {
      try {
        const saved = normalizePreferences(await getAppPreferences())
        if (cancelled) return
        setPreferencesWritable(true)
        setPreferenceError(null)
        setPreferences(saved)
        setAgentMode(saved.agent_mode)
        setSearch(saved.search)
        setSourceFilter(saved.source_filter)
        setGroupFilter(saved.group_filter)
        setSortKey(saved.sort_key as JobSortKey)
        setSortDirection(saved.sort_direction as SortDirection)
        setDetailOpen(saved.detail_open)
        setFormOpen(saved.form_open)
        setSelectedPlistPath(saved.selected_plist_path)
        setJobFormDraft(normalizeJobFormDraft(saved.job_form_draft))
        setWindowGeometry(saved.window_geometry)
      } catch (error) {
        if (!cancelled) {
          setPreferencesWritable(false)
          setPreferenceError(`Preferences could not be loaded; autosave is paused to protect the saved file: ${String(error)}`)
        }
      } finally {
        if (!cancelled) {
          setPreferencesReady(true)
        }
      }
    }

    void bootstrapPreferences()

    return () => {
      cancelled = true
    }
  }, [reloadPreferences, setGroupFilter, setSearch, setSourceFilter, setSortKey, setSortDirection])

  useEffect(() => {
    if (!preferencesReady || !preferencesWritable) return
    preferenceWriter.schedule({
      search, source_filter: sourceFilter, group_filter: groupFilter, sort_key: sortKey,
      sort_direction: sortDirection, agent_mode: agentMode, detail_open: detailOpen,
      form_open: formOpen, selected_plist_path: selectedPlistPath, job_form_draft: jobFormDraft,
      window_geometry: windowGeometry,
    })
    setPreferences({
      search,
      source_filter: sourceFilter,
      group_filter: groupFilter,
      sort_key: sortKey,
      sort_direction: sortDirection,
      agent_mode: agentMode,
      detail_open: detailOpen,
      form_open: formOpen,
      selected_plist_path: selectedPlistPath,
      job_form_draft: jobFormDraft,
      window_geometry: windowGeometry,
    })
  }, [
    agentMode,
    detailOpen,
    formOpen,
    jobFormDraft,
    preferencesReady,
    preferencesWritable,
    preferenceWriter,
    selectedPlistPath,
    windowGeometry,
    search,
    groupFilter,
    sourceFilter,
    sortDirection,
    sortKey,
  ])

  const handleAction = useCallback(
    async (action: () => Promise<void>) => {
      setActionError(null)
      try {
        await action()
      } catch (e) {
        setActionError(String(e))
      } finally { await refresh() }
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

      unlistenClose = await currentWindow.onCloseRequested(async (event) => {
        event.preventDefault()
        try { await preferenceWriter.flush() } catch { return }
        await hideApp().catch(() => undefined)
        await currentWindow.hide().catch(() => undefined)
      })

      unlistenCommand = await listen<string>(TRAY_COMMAND_EVENT, async (event) => {
        if (event.payload === "quit") {
          if (!writableRef.current && !window.confirm("Preferences could not be loaded. Quit and discard this session's unsaved preference edits?")) return
          try { await preferenceWriter.flush(); await finishQuit() }
          catch { await openControlCenter() }
          return
        }
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
          setJobFormDraft(createEmptyJobFormDraft())
          formGeneration.current += 1; setFormKey((k) => k + 1)
          setFormOpen(true)
        }
      })
    }

    void bootstrap()

    return () => {
      unlistenCommand?.()
      unlistenClose?.()
    }
  }, [openControlCenter, preferenceWriter, refresh])

  useEffect(() => {
    if (!preferencesReady) return

    const currentWindow = getCurrentWindow()
    let unlistenMoved: (() => void) | undefined
    let unlistenResized: (() => void) | undefined
    let cancelled = false

    const restoreAndTrackWindow = async () => {
      const monitors = await availableMonitors().catch(() => [])
      if (cancelled) return
      const areas = monitors.map((monitor) => ({ x: monitor.workArea.position.x, y: monitor.workArea.position.y, width: monitor.workArea.size.width, height: monitor.workArea.size.height }))
      const resolvedGeometry = fitWindow(windowGeometry, areas)
      if (resolvedGeometry) {
        await currentWindow.setSize(new PhysicalSize(resolvedGeometry.width, resolvedGeometry.height))
        if (cancelled) return
        await currentWindow.setPosition(new PhysicalPosition(resolvedGeometry.x, resolvedGeometry.y))
        if (cancelled) return
        setWindowGeometry(resolvedGeometry)
      } else {
        await currentWindow.center().catch(() => undefined)
      }

      unlistenMoved = await currentWindow.onMoved(async ({ payload }) => {
        if (cancelled) return
        setWindowGeometry((current) => {
          const next = {
            x: Math.round(payload.x),
            y: Math.round(payload.y),
            width: current?.width ?? resolvedGeometry?.width ?? 1200,
            height: current?.height ?? resolvedGeometry?.height ?? MIN_WINDOW_HEIGHT,
          }
          return sameWindowGeometry(current, next) ? current : next
        })
      })

      unlistenResized = await currentWindow.onResized(async ({ payload }) => {
        if (cancelled) return
        setWindowGeometry((current) => {
          const next = {
            x: current?.x ?? resolvedGeometry?.x ?? 0,
            y: current?.y ?? resolvedGeometry?.y ?? 0,
            width: Math.round(payload.width),
            height: Math.round(payload.height),
          }
          return sameWindowGeometry(current, next) ? current : next
        })
      })

      await openControlCenter()
    }

    void restoreAndTrackWindow().catch((error) => setActionError(`Window restoration failed: ${String(error)}`))

    return () => {
      cancelled = true
      unlistenMoved?.()
      unlistenResized?.()
    }
  }, [openControlCenter, preferencesReady])

  const handleSelect = useCallback((job: JobListEntry) => {
    editGeneration.current += 1
    setSelectedPlistPath(job.plist_path)
    setDetailOpen(true)
  }, [])

  const handleEdit = useCallback((job: LaunchdJob) => {
    setEditingJob(job)
    setJobFormDraft(createJobFormDraftFromJob(job))
    formGeneration.current += 1; setFormKey((k) => k + 1)
    setFormOpen(true)
    setDetailOpen(false)
  }, [])

  const handleRepair = useCallback(
    (job: LaunchdJob, diagnosis: ServiceDiagnosis | null) => {
      setEditingJob(job)
      setJobFormDraft(
        createRepairJobFormDraftFromJob(job, diagnosis?.suggested_metadata ?? null)
      )
      formGeneration.current += 1; setFormKey((k) => k + 1)
      setFormOpen(true)
      setDetailOpen(false)
    },
    []
  )

  const handleEditFromList = useCallback(async (job: JobListEntry) => {
    if (job.source !== "UserAgent") return
    setActionError(null)
    const generation = ++editGeneration.current
    try {
      const detail = await getJobDetail(job.plist_path)
      if (generation !== editGeneration.current) return
      handleEdit(detail)
    } catch (e) {
      if (generation === editGeneration.current) setActionError(String(e))
    }
  }, [handleEdit])

  const handleSave = useCallback(
    async (config: PlistConfig, plistPath?: string) => {
      const generation = formGeneration.current
      if (plistPath) {
        await saveJob(plistPath, config)
      } else {
        await createJob(config.label, config)
      }
      if (generation === formGeneration.current) setJobFormDraft(null)
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
  const groupSummaries = useMemo(() => {
    const grouped = new Map<
      string,
      {
        group: string
        total: number
        running: number
        attention: number
        logCoverage: number
        mutable: number
      }
    >()
    for (const job of jobs) {
      const group = job.metadata.group ?? "Ungrouped"
      const current =
        grouped.get(group) ?? { group, total: 0, running: 0, attention: 0, logCoverage: 0, mutable: 0 }
      current.total += 1
      if (job.status === "Running") current.running += 1
      if (deriveHealthText(job) === "Attention") {
        current.attention += 1
      }
      if (job.log_paths.stdout || job.log_paths.stderr) current.logCoverage += 1
      if (job.source === "UserAgent") current.mutable += 1
      grouped.set(group, current)
    }
    return [...grouped.values()].sort((a, b) => a.group.localeCompare(b.group))
  }, [jobs])
  const groupOptions = useMemo(
    () => groupSummaries.map((summary) => summary.group),
    [groupSummaries]
  )
  const handleBulkGroupAction = useCallback(
    async (group: string, action: "start" | "stop" | "restart" | "kickstart") => {
      const targets = jobs.filter(
        (job) => job.source === "UserAgent" && (job.metadata.group ?? "Ungrouped") === group
      )
      if (targets.length === 0) {
        return
      }
      const confirmation = window.confirm(
        `${bulkActionLabels[action]} ${targets.length} user agent${targets.length === 1 ? "" : "s"} in ${group}?`
      )
      if (!confirmation) {
        return
      }

      setActionError(null)
      const failures: string[] = []
      try {
        for (const target of targets) {
          try {
            if (action === "start") await startJob(target.plist_path)
            else if (action === "stop") await stopJob(target.plist_path)
            else if (action === "restart") await restartJob(target.plist_path)
            else await kickstartJob(target.label, target.plist_path)
          } catch (error) { failures.push(`${target.label}: ${String(error)}`) }
        }
      } finally {
        await refresh()
        if (failures.length) setActionError(`${failures.length} of ${targets.length} actions failed: ${failures.join("; ")}`)
      }
    },
    [jobs, refresh]
  )

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
                  macOS services
                </Badge>
                <ModeBadge mode={agentMode} />
              </div>

              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
                  Daemonic
                </h1>
                <p className="mt-2 max-w-3xl text-sm leading-6 text-slate-300">
                  Daemonic — Master Your macOS Services. A tray-first macOS control
                  center for launchd jobs with agent-driven workflows, local reasoning
                  hooks, and a deterministic launchctl executor under the hood.
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
                  setJobFormDraft(createEmptyJobFormDraft())
                  formGeneration.current += 1; setFormKey((k) => k + 1)
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

          {(error || actionError || preferenceError) && (
            <div className="space-y-2">
              {error && (
                <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200 shadow-lg shadow-rose-950/20">
                  {error}
                </div>
              )}
              {preferenceError && <p role="alert">{preferenceError} <Button onClick={() => { if (preferencesWritable) void preferenceWriter.flush().catch(() => undefined); else if (window.confirm("Reload saved preferences and replace this session's in-memory preference edits?")) setReloadPreferences((value) => value + 1) }}>{preferencesWritable ? "Retry pending save" : "Reload saved preferences"}</Button></p>}
              {actionError && (
                <div className="rounded-2xl border border-rose-500/30 bg-rose-500/10 p-4 text-sm text-rose-200 shadow-lg shadow-rose-950/20">
                  {actionError}
                </div>
              )}
            </div>
          )}

          <section className="grid flex-1 gap-4 2xl:grid-cols-[minmax(0,1.75fr)_minmax(320px,0.95fr)]">
            <div className="min-w-0 overflow-hidden rounded-3xl border border-white/10 bg-slate-950/70 shadow-2xl shadow-black/30 backdrop-blur-xl">
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
                  groupFilter={groupFilter}
                  onGroupFilterChange={setGroupFilter}
                  groupOptions={groupOptions}
                  />
                </div>

                {groupSummaries.length > 0 && (
                  <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {groupSummaries.map((summary) => (
                      <div
                        key={summary.group}
                        role="button"
                        tabIndex={0}
                        onClick={() =>
                          setGroupFilter(groupFilter === summary.group ? "All" : summary.group)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault()
                            setGroupFilter(
                              groupFilter === summary.group ? "All" : summary.group
                            )
                          }
                        }}
                        className={[
                          "rounded-2xl border p-3 text-left transition",
                          groupFilter === summary.group
                            ? "border-emerald-400/50 bg-emerald-400/10"
                            : "border-white/10 bg-white/5 hover:bg-white/10",
                        ].join(" ")}
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0">
                            <div className="truncate text-sm font-medium text-white">
                              {summary.group}
                            </div>
                            <div className="mt-1 text-xs text-slate-400">
                              {summary.total} services
                            </div>
                          </div>
                          {summary.attention > 0 && (
                            <Badge className="border-rose-400/30 bg-rose-400/10 text-rose-100 hover:bg-rose-400/10">
                              {summary.attention} attention
                            </Badge>
                          )}
                        </div>
                        <div className="mt-3 grid grid-cols-3 gap-2 text-xs text-slate-300">
                          <div>
                            <div className="font-medium text-white">{summary.running}</div>
                            <div>Running</div>
                          </div>
                          <div>
                            <div className="font-medium text-white">{summary.logCoverage}</div>
                            <div>Logged</div>
                          </div>
                          <div>
                            <div className="font-medium text-white">
                              {Math.round((summary.logCoverage / summary.total) * 100)}%
                            </div>
                            <div>Coverage</div>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 border-white/10 bg-white/5 text-xs text-slate-100 hover:bg-white/10"
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleBulkGroupAction(summary.group, "kickstart")
                            }}
                            disabled={summary.mutable === 0}
                          >
                            Test all
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 border-white/10 bg-white/5 text-xs text-slate-100 hover:bg-white/10"
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleBulkGroupAction(summary.group, "start")
                            }}
                            disabled={summary.mutable === 0}
                          >
                            Start all
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 border-white/10 bg-white/5 text-xs text-slate-100 hover:bg-white/10"
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleBulkGroupAction(summary.group, "stop")
                            }}
                            disabled={summary.mutable === 0}
                          >
                            Stop all
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="h-8 border-white/10 bg-white/5 text-xs text-slate-100 hover:bg-white/10"
                            onClick={(event) => {
                              event.stopPropagation()
                              void handleBulkGroupAction(summary.group, "restart")
                            }}
                            disabled={summary.mutable === 0}
                          >
                            Restart all
                          </Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

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
                  sortKey={sortKey}
                  sortDirection={sortDirection}
                  onSortChange={(key, direction) => { setSortKey(key); setSortDirection(direction) }}
                  jobs={filteredJobs}
                  loading={loading}
                  onStart={(job) => handleAction(() => startJob(job.plist_path))}
                  onStop={(job) => handleAction(() => stopJob(job.plist_path))}
                  onRestart={(job) => handleAction(() => restartJob(job.plist_path))}
                  onKickstart={(job) => handleAction(() => kickstartJob(job.label, job.plist_path))}
                  onEdit={(job) => void handleEditFromList(job)}
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
          onRepair={handleRepair}
        />

        <JobForm
          key={formKey}
          open={formOpen}
          onClose={() => {
            formGeneration.current += 1
            setFormOpen(false)
            setEditingJob(null)
          }}
          onSave={handleSave}
          editingJob={editingJob}
          draft={jobFormDraft}
          onDraftChange={setJobFormDraft}
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
