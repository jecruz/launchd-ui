import { validateSchedule, validateHourRange } from "@/lib/schedule-validation"
import { useEffect, useRef, useState } from "react"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type {
  CalendarInterval,
  JobFormDraft,
  JobFormHourMode,
  JobFormScheduleType,
  LaunchControlMetadata,
  LaunchdJob,
  PlistConfig,
} from "@/types"
import { getHomeDir } from "@/lib/invoke"
import {
  detectHourRange,
  expandHourRange,
  getNextOccurrences,
  getNextOccurrencesMulti,
  formatDateTime,
} from "@/lib/calendar-utils"
import { getAgentRuntimeSummary, runAgentPrompt } from "@/lib/invoke"

type JobFormProps = {
  open: boolean
  onClose: () => void
  onSave: (config: PlistConfig, plistPath?: string) => Promise<void>
  editingJob?: LaunchdJob | null
  draft: JobFormDraft | null
  onDraftChange: (draft: JobFormDraft | null) => void
}

type GeneratedJobFormDraft = {
  label: string
  args: string
  group: string | null
  tags: string[]
  managed_by: string | null
  description: string | null
  environment: string | null
  health_check_url: string | null
  health_check_command: string | null
  ports: number[]
  template: string | null
  migration_hint: string | null
  schedule_type: JobFormScheduleType
  run_at_load: boolean | null
  keep_alive: boolean | null
  start_interval: number | null
  calendar_interval: CalendarInterval | null
  hour_mode: JobFormHourMode
  hour_range: { from: number; to: number }
  working_directory: string | null
  standard_out_path: string | null
  standard_error_path: string | null
  environment_variables: Record<string, string> | null
  disabled: boolean | null
  wake_system: boolean | null
  summary: string
  notes: string[]
  risks: string[]
}

type ServiceTemplateKey = "api" | "worker" | "scheduler" | "watcher" | "static" | "mcp"

type ServiceTemplatePreset = {
  label: string
  description: string
  group: string
  tags: string[]
  managed_by: string
  environment: string
  run_at_load: boolean
  keep_alive: boolean
  ports: number[]
  health_check_url: string | null
  health_check_command: string | null
  migration_hint: string
}

type RepairMetadataHints = Pick<
  LaunchControlMetadata,
  "health_check_url" | "health_check_command" | "ports" | "template" | "migration_hint"
>

const DRAFT_SCHEMA = "Use these keys exactly: label, args, group, tags, managed_by, description, environment, health_check_url, health_check_command, ports, template, migration_hint, schedule_type, run_at_load, keep_alive, start_interval, calendar_interval, hour_mode, hour_range, working_directory, standard_out_path, standard_error_path, environment_variables, disabled, wake_system, summary, notes, risks."
const APP_NAME = "Daemonic"
const APP_DIR_NAME = "Daemonic"

const serviceTemplatePresets: Record<ServiceTemplateKey, ServiceTemplatePreset> = {
  api: {
    label: "API Service",
    description: "HTTP API service with a health endpoint.",
    group: "CAISS System",
    tags: ["caiss", "api", "local-infra"],
    managed_by: APP_NAME,
    environment: "local",
    run_at_load: true,
    keep_alive: true,
    ports: [8001],
    health_check_url: "http://127.0.0.1:8001/health",
    health_check_command: null,
    migration_hint: "docker-compose",
  },
  worker: {
    label: "Background Worker",
    description: "Long-running worker or queue consumer.",
    group: "CAISS System",
    tags: ["caiss", "worker", "local-infra"],
    managed_by: APP_NAME,
    environment: "local",
    run_at_load: true,
    keep_alive: true,
    ports: [],
    health_check_url: null,
    health_check_command: "pgrep -f worker",
    migration_hint: "docker-compose",
  },
  scheduler: {
    label: "Scheduler",
    description: "Cron-style launchd job with scheduled execution.",
    group: "CAISS System",
    tags: ["caiss", "scheduler", "local-infra"],
    managed_by: APP_NAME,
    environment: "local",
    run_at_load: false,
    keep_alive: false,
    ports: [],
    health_check_url: null,
    health_check_command: null,
    migration_hint: "docker-compose",
  },
  watcher: {
    label: "Watcher",
    description: "File or event watcher with a persistent process.",
    group: "CAISS System",
    tags: ["caiss", "watcher", "local-infra"],
    managed_by: APP_NAME,
    environment: "local",
    run_at_load: true,
    keep_alive: true,
    ports: [],
    health_check_url: null,
    health_check_command: "pgrep -f watcher",
    migration_hint: "docker-compose",
  },
  static: {
    label: "Static Server",
    description: "Local static content server.",
    group: "CAISS System",
    tags: ["caiss", "static", "local-infra"],
    managed_by: APP_NAME,
    environment: "local",
    run_at_load: true,
    keep_alive: true,
    ports: [8080],
    health_check_url: "http://127.0.0.1:8080/",
    health_check_command: null,
    migration_hint: "docker-compose",
  },
  mcp: {
    label: "MCP Server",
    description: "Local MCP-compatible service.",
    group: "CAISS System",
    tags: ["caiss", "mcp", "local-infra"],
    managed_by: APP_NAME,
    environment: "local",
    run_at_load: true,
    keep_alive: true,
    ports: [8000],
    health_check_url: "http://127.0.0.1:8000/health",
    health_check_command: null,
    migration_hint: "docker-compose",
  },
}

function parseArguments(input: string): string[] {
  const result: string[] = []
  let current = ""
  let inDouble = false
  let inSingle = false

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble
    } else if (ch === "'" && !inDouble) {
      inSingle = !inSingle
    } else if (ch === " " && !inDouble && !inSingle) {
      if (current.length > 0) {
        result.push(current)
        current = ""
      }
    } else {
      current += ch
    }
  }
  if (current.length > 0) {
    result.push(current)
  }
  return result
}

function formatArguments(args: string[]): string {
  return args
    .map((arg) => (arg.includes(" ") ? `"${arg}"` : arg))
    .join(" ")
}

function emptyConfig(): PlistConfig {
  return {
    label: "",
    program: null,
    program_arguments: null,
    run_at_load: false,
    keep_alive: false,
    start_interval: null,
    start_calendar_interval: null,
    standard_out_path: null,
    standard_error_path: null,
    working_directory: null,
    environment_variables: null,
    disabled: false,
    wake_system: false,
    metadata: {
      group: null,
      tags: [],
      managed_by: APP_NAME,
      description: null,
      environment: "local",
      health_check_url: null,
      health_check_command: null,
      ports: [],
      template: null,
      migration_hint: null,
      health_status: null,
      health_detail: null,
      last_health_check_at: null,
    },
    raw_xml: "",
  }
}

function detectScheduleType(config: PlistConfig): JobFormScheduleType {
  if (config.start_interval) return "interval"
  if (config.start_calendar_interval && config.start_calendar_interval.length > 0) return "calendar"
  return "none"
}

function detectHourMode(config: PlistConfig): JobFormHourMode {
  if (config.start_calendar_interval && config.start_calendar_interval.length > 0) {
    const range = detectHourRange(config.start_calendar_interval)
    if (range) return "range"
    const first = config.start_calendar_interval[0]
    if (first.hour === null || first.hour === undefined) return "every"
  }
  return "specific"
}

const weekdayLabels = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
const serviceTemplateOptions: Array<{ value: "custom" | ServiceTemplateKey; label: string }> = [
  { value: "custom", label: "Custom" },
  { value: "api", label: "API Service" },
  { value: "worker", label: "Worker" },
  { value: "scheduler", label: "Scheduler" },
  { value: "watcher", label: "Watcher" },
  { value: "static", label: "Static Server" },
  { value: "mcp", label: "MCP Server" },
]

function resolveTemplateKey(value: string | null | undefined): ServiceTemplateKey | null {
  if (!value) return null
  return Object.prototype.hasOwnProperty.call(serviceTemplatePresets, value) ? (value as ServiceTemplateKey) : null
}

function parseDeclaredPort(programArguments: string[] | null): number | null {
  if (!programArguments) return null

  for (let index = 0; index < programArguments.length; index += 1) {
    const arg = programArguments[index]
    const inline = arg.match(/^--port=(\d+)$/)
    if (inline) {
      return Number.parseInt(inline[1], 10)
    }
    if (arg === "--port") {
      const next = programArguments[index + 1]
      if (next && /^\d+$/.test(next)) {
        return Number.parseInt(next, 10)
      }
    }
    const portEquals = arg.match(/^port=(\d+)$/)
    if (portEquals) {
      return Number.parseInt(portEquals[1], 10)
    }
  }

  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function toNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Generated numeric fields must be numbers.")
  return value
}

function toStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []
}

function parseGeneratedJobFormDraft(input: string, migration = false): GeneratedJobFormDraft | null {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced ?? input.trim()
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start < 0 || end < 0 || end <= start) return null

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as Partial<GeneratedJobFormDraft> & {
      calendar_interval?: unknown
      hour_range?: unknown
    }

    if (typeof parsed.label !== "string" || typeof parsed.args !== "string") {
      return null
    }
    if (migration && ["ports", "working_directory", "environment_variables", "schedule_type", "start_interval", "calendar_interval", "hour_mode", "hour_range"].some((key) => !Object.prototype.hasOwnProperty.call(parsed, key))) return null

    const schedule_type =
      parsed.schedule_type === "interval" || parsed.schedule_type === "calendar"
        ? parsed.schedule_type
        : "none"
    const hour_mode =
      parsed.hour_mode === "every" || parsed.hour_mode === "range" ? parsed.hour_mode : "specific"

    const calendar_interval = isRecord(parsed.calendar_interval)
      ? {
          minute: toNullableNumber(parsed.calendar_interval.minute),
          hour: toNullableNumber(parsed.calendar_interval.hour),
          day: toNullableNumber(parsed.calendar_interval.day),
          weekday: toNullableNumber(parsed.calendar_interval.weekday),
          month: toNullableNumber(parsed.calendar_interval.month),
        }
      : null

    const hour_range = isRecord(parsed.hour_range)
      ? {
          from: toNullableNumber(parsed.hour_range.from) ?? 7,
          to: toNullableNumber(parsed.hour_range.to) ?? 23,
        }
      : { from: 7, to: 23 }

    validateSchedule(toNullableNumber(parsed.start_interval), calendar_interval ? [calendar_interval] : null)
    validateHourRange(hour_range.from, hour_range.to)
    if (schedule_type === "interval" && (!Number.isSafeInteger(parsed.start_interval) || Number(parsed.start_interval) < 1)) return null
    if (schedule_type === "calendar" && !calendar_interval) return null
    if (Array.isArray(parsed.ports) && parsed.ports.some((value) => !Number.isInteger(value) || value < 1 || value > 65535)) return null

    return {
      label: parsed.label,
      args: parsed.args,
      group: typeof parsed.group === "string" && parsed.group.trim().length > 0 ? parsed.group : null,
      tags: toStringArray(parsed.tags),
      managed_by:
        typeof parsed.managed_by === "string" && parsed.managed_by.trim().length > 0
          ? parsed.managed_by
          : APP_NAME,
      description:
        typeof parsed.description === "string" && parsed.description.trim().length > 0
          ? parsed.description
          : null,
      environment:
        typeof parsed.environment === "string" && parsed.environment.trim().length > 0
          ? parsed.environment
          : "local",
      health_check_url:
        typeof parsed.health_check_url === "string" && parsed.health_check_url.trim().length > 0
          ? parsed.health_check_url
          : null,
      health_check_command:
        typeof parsed.health_check_command === "string" &&
        parsed.health_check_command.trim().length > 0
          ? parsed.health_check_command
          : null,
      ports: Array.isArray(parsed.ports)
        ? parsed.ports as number[]
        : [],
      template:
        typeof parsed.template === "string" && parsed.template.trim().length > 0
          ? parsed.template
          : null,
      migration_hint:
        typeof parsed.migration_hint === "string" && parsed.migration_hint.trim().length > 0
          ? parsed.migration_hint
          : null,
      schedule_type,
      run_at_load: typeof parsed.run_at_load === "boolean" ? parsed.run_at_load : null,
      keep_alive: typeof parsed.keep_alive === "boolean" ? parsed.keep_alive : null,
      start_interval: toNullableNumber(parsed.start_interval),
      calendar_interval,
      hour_mode,
      hour_range,
      working_directory:
        typeof parsed.working_directory === "string" && parsed.working_directory.trim().length > 0
          ? parsed.working_directory
          : null,
      standard_out_path:
        typeof parsed.standard_out_path === "string" && parsed.standard_out_path.trim().length > 0
          ? parsed.standard_out_path
          : null,
      standard_error_path:
        typeof parsed.standard_error_path === "string" &&
        parsed.standard_error_path.trim().length > 0
          ? parsed.standard_error_path
          : null,
      environment_variables: isRecord(parsed.environment_variables)
        ? Object.fromEntries(
            Object.entries(parsed.environment_variables).filter(
              (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string"
            )
          )
        : null,
      disabled: typeof parsed.disabled === "boolean" ? parsed.disabled : null,
      wake_system: typeof parsed.wake_system === "boolean" ? parsed.wake_system : null,
      summary: typeof parsed.summary === "string" ? parsed.summary : "",
      notes: toStringArray(parsed.notes),
      risks: toStringArray(parsed.risks),
    }
  } catch {
    return null
  }
}

function buildGeneratedDraftPrompt(request: string): string {
  return [
    "You are drafting a new user LaunchAgent for Daemonic.",
    "Return valid JSON only. No markdown fences, commentary, or prose.",
    DRAFT_SCHEMA,
    "Values should be conservative defaults suitable for a user agent under ~/Library/LaunchAgents.",
    "label must be reverse-DNS style and unique.",
    "group should identify the service family, for example CAISS System.",
    "tags should include short lowercase tags for filtering.",
    "managed_by should be Daemonic unless the user says otherwise.",
    "ports should be a JSON array of numbers when the service listens on local ports.",
    "health_check_url should be a local URL when the service exposes HTTP health.",
    "health_check_command should be a short command when URL checks are not available.",
    "template should be a short service family label such as api, worker, scheduler, watcher, static, or mcp.",
    "args must contain the executable followed by its arguments as a single shell-style string.",
    "schedule_type must be one of none, interval, or calendar.",
    "hour_mode must be one of specific, every, or range.",
    "calendar_interval should be an object with minute, hour, day, weekday, and month keys, using null when a field is not needed.",
    "hour_range should be an object with from and to integers when hour_mode is range, otherwise use 7 and 23.",
    "Use null for fields that are not required.",
    "If the request is underspecified, choose safe defaults and explain them in notes.",
    "User request:",
    request,
  ].join("\n")
}

export function createEmptyJobFormDraft(): JobFormDraft {
  return {
    editing_plist_path: null,
    config: emptyConfig(),
    args: "",
    schedule_type: "none",
    hour_mode: "specific",
    calendar_interval: null,
    hour_range: { from: 7, to: 23 },
  }
}

export function createJobFormDraftFromJob(job: LaunchdJob): JobFormDraft {
  const existingRange = job.plist.start_calendar_interval
    ? detectHourRange(job.plist.start_calendar_interval)
    : null
  const selectedCalendarInterval =
    existingRange?.base ?? job.plist.start_calendar_interval?.[0] ?? null

  return {
    editing_plist_path: job.plist_path,
    config: job.plist,
    args: job.plist.program_arguments ? formatArguments(job.plist.program_arguments) : "",
    schedule_type: detectScheduleType(job.plist),
    hour_mode: detectHourMode(job.plist),
    calendar_interval: selectedCalendarInterval,
    hour_range: existingRange ? { from: existingRange.from, to: existingRange.to } : { from: 7, to: 23 },
  }
}

function buildRepairMetadataHints(
  job: LaunchdJob,
  suggestedMetadata: LaunchControlMetadata | null | undefined
): RepairMetadataHints {
  const labelLower = job.label.toLowerCase()
  const declaredPort = parseDeclaredPort(job.plist.program_arguments)
  const currentTemplateKey = resolveTemplateKey(job.plist.metadata.template)
  const suggestedTemplateKey = resolveTemplateKey(suggestedMetadata?.template ?? null)

  if (suggestedMetadata) {
    return {
      health_check_url: suggestedMetadata.health_check_url,
      health_check_command: suggestedMetadata.health_check_command,
      ports: suggestedMetadata.ports,
      template: suggestedTemplateKey,
      migration_hint: suggestedMetadata.migration_hint,
    }
  }

  const templatePreset = currentTemplateKey ? serviceTemplatePresets[currentTemplateKey] : null
  const inferredPort = declaredPort ?? job.plist.metadata.ports[0] ?? null

  return {
    health_check_url:
      templatePreset?.health_check_url ??
      (labelLower.includes("uptime-kuma") && inferredPort
        ? `http://127.0.0.1:${inferredPort}/`
        : inferredPort
          ? `http://127.0.0.1:${inferredPort}/health`
          : null),
    health_check_command: templatePreset?.health_check_command ?? null,
    ports: templatePreset?.ports.length
      ? templatePreset.ports
      : job.plist.metadata.ports.length > 0
        ? job.plist.metadata.ports
        : inferredPort
          ? [inferredPort]
          : [],
    template: currentTemplateKey,
    migration_hint: templatePreset?.migration_hint ?? null,
  }
}

/**
 * Create a repair-focused draft that pre-fills health-check fields when a service type can be inferred.
 */
export function createRepairJobFormDraftFromJob(
  job: LaunchdJob,
  suggestedMetadata?: LaunchControlMetadata | null
): JobFormDraft {
  const draft = createJobFormDraftFromJob(job)
  const hints = buildRepairMetadataHints(job, suggestedMetadata)
  const currentMetadata = draft.config.metadata

  return {
    ...draft,
    config: {
      ...draft.config,
      metadata: {
        ...currentMetadata,
        health_check_url: suggestedMetadata
          ? hints.health_check_url
          : currentMetadata.health_check_url ?? hints.health_check_url,
        health_check_command: suggestedMetadata
          ? hints.health_check_command
          : currentMetadata.health_check_command ?? hints.health_check_command,
        ports: suggestedMetadata
          ? hints.ports
          : currentMetadata.ports.length > 0
            ? currentMetadata.ports
            : hints.ports,
        template: suggestedMetadata
          ? hints.template
          : currentMetadata.template ?? hints.template,
        migration_hint: suggestedMetadata
          ? hints.migration_hint
          : currentMetadata.migration_hint ?? hints.migration_hint,
      },
    },
  }
}

/** Edit a single draft, rehydrating explicit incoming targets without overwriting local edits. */
export function JobForm({ open, onClose, onSave, editingJob, draft, onDraftChange }: JobFormProps) {
  const initialDraft = draft ?? (editingJob ? createJobFormDraftFromJob(editingJob) : createEmptyJobFormDraft())
  const [config, setConfig] = useState<PlistConfig>(initialDraft.config)
  const [args, setArgs] = useState(initialDraft.args)
  const [scheduleType, setScheduleType] = useState<JobFormScheduleType>(initialDraft.schedule_type)
  const existingRange = initialDraft.config.start_calendar_interval
    ? detectHourRange(initialDraft.config.start_calendar_interval)
    : null
  const [calendarInterval, setCalendarInterval] = useState<CalendarInterval>(
    initialDraft.calendar_interval ??
      (existingRange
        ? existingRange.base
        : initialDraft.config.start_calendar_interval?.[0] ?? {
            minute: 0,
            hour: 9,
            day: null,
            weekday: null,
            month: null,
          })
  )
  const [hourMode, setHourMode] = useState<JobFormHourMode>(initialDraft.hour_mode)
  const [hourRange, setHourRange] = useState<{ from: number; to: number }>(initialDraft.hour_range)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draftPrompt, setDraftPrompt] = useState("")
  const [drafting, setDrafting] = useState(false)
  const [draftStatus, setDraftStatus] = useState<string | null>(null)
  const [migrationPrompt, setMigrationPrompt] = useState("")
  const [migrationDrafting, setMigrationDrafting] = useState(false)
  const [migrationStatus, setMigrationStatus] = useState<string | null>(null)
  const [runtimeReady, setRuntimeReady] = useState(false)
  const [runtimeSummary, setRuntimeSummary] = useState<string>("")
  const [homeDir, setHomeDir] = useState<string | null>(null)

  const formGeneration = useRef(0)
  useEffect(() => () => { formGeneration.current += 1 }, [])
  const lastEmitted = useRef<JobFormDraft | null>(null)
  const lastInput = useRef<{ open: boolean; path: string | null; draft: JobFormDraft | null | undefined }>({ open: false, path: null, draft: undefined })
  const hydrating = useRef(false)
  const [hydrationVersion, setHydrationVersion] = useState(0)
  const [sensitiveOmitted, setSensitiveOmitted] = useState(initialDraft.sensitive_fields_omitted ?? false)

  useEffect(() => {
    const path = editingJob?.plist_path ?? draft?.editing_plist_path ?? null
    const changed = open && (!lastInput.current.open || path !== lastInput.current.path || (draft !== lastInput.current.draft && draft !== lastEmitted.current))
    lastInput.current = { open, path, draft }
    if (!changed) return
    const next = editingJob && draft?.editing_plist_path !== editingJob.plist_path
      ? createJobFormDraftFromJob(editingJob)
      : draft ?? (editingJob ? createJobFormDraftFromJob(editingJob) : createEmptyJobFormDraft())
    formGeneration.current += 1
    hydrating.current = true
    setConfig(next.config)
    setArgs(next.args)
    setScheduleType(next.schedule_type)
    setHourMode(next.hour_mode)
    setHourRange(next.hour_range)
    setCalendarInterval(next.calendar_interval ?? next.config.start_calendar_interval?.[0] ?? { minute: 0, hour: 9, day: null, weekday: null, month: null })
    setSensitiveOmitted(next.sensitive_fields_omitted ?? false)
    setSaving(false)
    setDrafting(false)
    setMigrationDrafting(false)
    setDraftStatus(null)
    setMigrationStatus(null)
    setError(null)
    setHydrationVersion((value) => value + 1)
  }, [open, draft, editingJob])

  const applyCalendarPreset = (preset: "daily" | "weekday" | "hourly") => {
    setScheduleType("calendar")
    if (preset === "daily") {
      setHourMode("specific")
      setCalendarInterval({
        minute: 0,
        hour: 9,
        day: null,
        weekday: null,
        month: null,
      })
      return
    }
    if (preset === "weekday") {
      setHourMode("specific")
      setCalendarInterval({
        minute: 0,
        hour: 9,
        day: null,
        weekday: 1,
        month: null,
      })
      return
    }
    setHourMode("every")
    setCalendarInterval({
      minute: 0,
      hour: null,
      day: null,
      weekday: null,
      month: null,
    })
  }

  const editTargetPath = editingJob?.plist_path ?? initialDraft.editing_plist_path
  const isEditing = !!editTargetPath

  useEffect(() => {
    if (!isEditing) {
      getHomeDir().then(setHomeDir).catch(() => {})
    }
  }, [isEditing])

  useEffect(() => {
    if (!open || isEditing) {
      setRuntimeReady(false)
      setRuntimeSummary("")
      return
    }

    let cancelled = false

    getAgentRuntimeSummary()
      .then((summary) => {
        if (cancelled) return
        setRuntimeReady(summary.configured)
        setRuntimeSummary(
          summary.configured
            ? `Uses ${summary.provider_label}. Save Runtime and Smoke Test Runtime first.`
            : summary.details[0] ?? "Configure the local agent runtime before drafting."
        )
      })
      .catch(() => {
        if (!cancelled) {
          setRuntimeReady(false)
          setRuntimeSummary("Configure the local agent runtime before drafting.")
        }
      })

    return () => {
      cancelled = true
    }
  }, [isEditing, open])

  useEffect(() => {
    if (open) return
    setDraftPrompt("")
    setDraftStatus(null)
    setDrafting(false)
    setMigrationPrompt("")
    setMigrationDrafting(false)
    setMigrationStatus(null)
    setError(null)
    setRuntimeReady(false)
    setRuntimeSummary("")
  }, [open])

  useEffect(() => {
    if (!open) return
    if (hydrating.current) { hydrating.current = false; return }
    const next: JobFormDraft = {
      sensitive_fields_omitted: sensitiveOmitted,
      editing_plist_path: editTargetPath ?? null,
      config,
      args,
      schedule_type: scheduleType,
      hour_mode: hourMode,
      calendar_interval: calendarInterval,
      hour_range: hourRange,
    }
    lastEmitted.current = next
    onDraftChange(next)
  }, [open, hydrationVersion, sensitiveOmitted, args, calendarInterval, config, editTargetPath, hourMode, hourRange, onDraftChange, scheduleType])

  const applyGeneratedDraft = (generated: GeneratedJobFormDraft) => {
    const parsedArgs = generated.args.trim() ? parseArguments(generated.args.trim()) : []
    const nextConfig: PlistConfig = {
      ...config,
      label: generated.label.replace(/\s/g, ""),
      program: parsedArgs[0] ?? null,
      program_arguments: parsedArgs.length > 0 ? parsedArgs : null,
      run_at_load: generated.run_at_load,
      keep_alive: generated.keep_alive,
      start_interval: generated.schedule_type === "interval" ? generated.start_interval : null,
      start_calendar_interval:
        generated.schedule_type === "calendar"
          ? generated.hour_mode === "range"
            ? expandHourRange(
                generated.calendar_interval ?? {
                  minute: 0,
                  hour: 9,
                  day: null,
                  weekday: null,
                  month: null,
                },
                generated.hour_range.from,
                generated.hour_range.to
              )
            : generated.calendar_interval
              ? [generated.calendar_interval]
              : null
          : null,
      standard_out_path: generated.standard_out_path,
      standard_error_path: generated.standard_error_path,
      working_directory: generated.working_directory,
      environment_variables: generated.environment_variables,
      disabled: generated.disabled,
      wake_system: generated.wake_system,
      metadata: {
        group: generated.group,
        tags: generated.tags,
        managed_by: generated.managed_by,
        description: generated.description,
        environment: generated.environment,
        health_check_url: generated.health_check_url,
        health_check_command: generated.health_check_command,
        ports: generated.ports,
        template: generated.template,
        migration_hint: generated.migration_hint,
        health_status: null,
        health_detail: null,
        last_health_check_at: null,
      },
      raw_xml: config.raw_xml,
    }

    setConfig(nextConfig)
    setArgs(generated.args)
    setScheduleType(generated.schedule_type)
    setHourMode(generated.hour_mode)
    setHourRange(generated.hour_range)
    setCalendarInterval(
      generated.calendar_interval ?? {
        minute: 0,
        hour: 9,
        day: null,
        weekday: null,
        month: null,
      }
    )
    setDraftStatus(
      [
        generated.summary || "Draft generated. Review the plist settings before saving.",
        ...(generated.notes.length > 0 ? [`Notes: ${generated.notes.join(" • ")}`] : []),
      ].join(" ")
    )
  }

  const applyServiceTemplate = (templateKey: ServiceTemplateKey) => {
    const template = serviceTemplatePresets[templateKey]
    const nextLabel = config.label.trim() || `com.daemonic.${templateKey}`
    const nextLogDir = homeDir ? `${homeDir}/Library/Logs/${APP_DIR_NAME}` : null
    setConfig({
      ...config,
      run_at_load: template.run_at_load,
      keep_alive: template.keep_alive,
      standard_out_path: nextLogDir ? `${nextLogDir}/${nextLabel}.stdout.log` : config.standard_out_path,
      standard_error_path: nextLogDir ? `${nextLogDir}/${nextLabel}.stderr.log` : config.standard_error_path,
      metadata: {
        ...config.metadata,
        group: template.group,
        tags: template.tags,
        managed_by: template.managed_by,
        description: template.description,
        environment: template.environment,
        health_check_url: template.health_check_url,
        health_check_command: template.health_check_command,
        ports: template.ports,
        template: templateKey,
        migration_hint: template.migration_hint,
      },
    })
    setDraftStatus(`Applied ${template.label} template. Review the generated command and logs.`)
  }

  const handleGenerateMigrationDraft = async () => {
    setError(null)
    setMigrationStatus(null)
    if (isEditing) {
      setError("Migration assistant is only available when creating a new LaunchAgent.")
      return
    }
    if (!runtimeReady) {
      setError("Configure the local agent runtime in the Local agent panel first.")
      return
    }
    if (!migrationPrompt.trim()) {
      setError("Paste a Docker, OrbStack, or service definition to migrate.")
      return
    }

    setMigrationDrafting(true)
    const generation = formGeneration.current
    try {
      const result = await runAgentPrompt({
        prompt: [
          "Convert the following Docker/OrbStack service into a launchd LaunchAgent draft.",
          "Return valid JSON only.",
          DRAFT_SCHEMA,
          "Prefer a user LaunchAgent under ~/Library/LaunchAgents, with group/tags that make the service easy to find later.",
          "Preserve the command, ports, working directory, environment variables, and log paths when available.",
          "If the input is underspecified, choose safe defaults and explain them in notes.",
          "Source definition:",
          migrationPrompt.trim(),
        ].join("\n"),
        job_context: null,
        mode: "launchagent-migrate",
      })
      if (generation !== formGeneration.current) return
      const generated = parseGeneratedJobFormDraft(result.response, true)
      if (!generated) {
        throw new Error("The local model did not return a valid migration draft.")
      }
      if (!generated.label.trim()) {
        throw new Error("The generated migration draft is missing a label.")
      }
      applyGeneratedDraft(generated)
      setMigrationStatus("Migration draft generated. Review before saving.")
    } catch (e) {
      if (generation === formGeneration.current) setError(String(e))
    } finally {
      if (generation === formGeneration.current) setMigrationDrafting(false)
    }
  }

  const handleGenerateDraft = async () => {
    setError(null)
    setDraftStatus(null)
    if (isEditing) {
      setError("AI drafting is only available when creating a new LaunchAgent.")
      return
    }
    if (!runtimeReady) {
      setError("Configure the local agent runtime in the Local agent panel first.")
      return
    }
    if (!draftPrompt.trim()) {
      setError("Describe the LaunchAgent you want to create.")
      return
    }

    setDrafting(true)
    const generation = formGeneration.current
    try {
      const result = await runAgentPrompt({
        prompt: buildGeneratedDraftPrompt(draftPrompt.trim()),
        job_context: null,
        mode: "launchagent-draft",
      })
      if (generation !== formGeneration.current) return
      const generated = parseGeneratedJobFormDraft(result.response)
      if (!generated) {
        throw new Error("The local model did not return a valid LaunchAgent draft.")
      }
      if (!generated.label.trim()) {
        throw new Error("The generated draft is missing a label.")
      }
      if (generated.schedule_type === "interval" && !generated.start_interval) {
        throw new Error("The generated draft is missing an interval value.")
      }
      if (generated.schedule_type === "calendar" && !generated.calendar_interval) {
        throw new Error("The generated draft is missing a calendar interval.")
      }
      applyGeneratedDraft(generated)
    } catch (e) {
      if (generation === formGeneration.current) setError(String(e))
    } finally {
      if (generation === formGeneration.current) setDrafting(false)
    }
  }

  const handleSave = async () => {
    setError(null)
    if (!config.label.trim()) {
      setError("Label is required")
      return
    }
    if (scheduleType === "calendar" && hourMode === "range" && hourRange.from > hourRange.to) {
      setError("Hour range 'from' must be less than or equal to 'to'")
      return
    }

    const parsedArgs = args.trim() ? parseArguments(args.trim()) : null
    const finalConfig: PlistConfig = {
      ...config,
      program_arguments: parsedArgs,
      program: parsedArgs ? parsedArgs[0] : config.program,
      start_interval: scheduleType === "interval" ? (config.start_interval || null) : null,
      start_calendar_interval: scheduleType === "calendar"
        ? hourMode === "range"
          ? expandHourRange(calendarInterval, hourRange.from, hourRange.to)
          : [calendarInterval]
        : null,
      wake_system: scheduleType === "calendar" ? (config.wake_system || null) : null,
      standard_out_path: config.standard_out_path?.trim() || null,
      standard_error_path: config.standard_error_path?.trim() || null,
      working_directory: config.working_directory?.trim() || null,
    }

    try {
      if (scheduleType === "interval" && !config.start_interval) throw new Error("Interval must be a positive whole number of seconds.")
      if (scheduleType === "calendar" && hourMode === "range") validateHourRange(hourRange.from, hourRange.to)
      validateSchedule(finalConfig.start_interval, finalConfig.start_calendar_interval)
    } catch (error) { setError(String(error)); return }
    setSaving(true)
    const generation = formGeneration.current
    try {
      await onSave(finalConfig, editTargetPath ?? undefined)
      if (generation !== formGeneration.current) return
      onDraftChange(null)
      onClose()
    } catch (e) {
      if (generation === formGeneration.current) setError(String(e))
    } finally {
      if (generation === formGeneration.current) setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <DialogContent className="sm:max-w-[500px] max-h-[85vh] overflow-y-auto">
        {sensitiveOmitted && <p role="status" className="text-sm text-amber-300">Restored drafts omit command arguments, environment values, and raw plist content. Re-enter these before saving.</p>}
        <DialogHeader>
          <DialogTitle>
            {isEditing ? "Edit Agent" : "New Agent"}
          </DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Update an existing user LaunchAgent plist."
              : "Create a new user LaunchAgent plist for ~/Library/LaunchAgents."}
          </DialogDescription>
        </DialogHeader>

        {!isEditing && (
          <div className="rounded-2xl border border-cyan-400/20 bg-cyan-400/10 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-cyan-100/70">
                  LLM draft
                </p>
                <h4 className="mt-1 text-sm font-semibold text-cyan-50">
                  Ask the local model to prefill a new LaunchAgent
                </h4>
              </div>
              <p className="text-xs text-cyan-50/80">
                {runtimeReady ? "Ready" : "Needs local runtime"}
              </p>
            </div>
            <textarea
              value={draftPrompt}
              onChange={(e) => setDraftPrompt(e.target.value)}
              className="mt-3 min-h-24 w-full rounded-md border border-white/10 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 outline-none focus-visible:ring-2 focus-visible:ring-cyan-400"
              placeholder={`Example: create a user LaunchAgent that runs /usr/local/bin/backup.sh every day at 2am and writes logs to ~/Library/Logs/${APP_DIR_NAME}`}
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-5 text-cyan-50/75">
                {runtimeSummary ||
                  "Configure the local agent runtime first, then use this to draft the plist fields. Save is still manual."}
              </p>
              <Button
                type="button"
                onClick={handleGenerateDraft}
                disabled={drafting || !runtimeReady}
                className="bg-cyan-500 text-slate-950 hover:bg-cyan-400"
              >
                {drafting ? "Drafting..." : "Draft with AI"}
              </Button>
            </div>
            {draftStatus && (
              <p className="mt-3 rounded-xl border border-white/10 bg-black/15 px-3 py-2 text-sm text-cyan-50">
                {draftStatus}
              </p>
            )}
          </div>
        )}

        {!isEditing && (
          <div className="rounded-2xl border border-amber-400/20 bg-amber-400/10 p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-[0.22em] text-amber-50/70">
                  Migration assistant
                </p>
                <h4 className="mt-1 text-sm font-semibold text-amber-50">
                  Convert Docker or OrbStack service definitions into launchd
                </h4>
              </div>
              <p className="text-xs text-amber-50/80">
                {migrationDrafting ? "Drafting..." : "Paste a compose service or command"}
              </p>
            </div>
            <textarea
              value={migrationPrompt}
              onChange={(e) => setMigrationPrompt(e.target.value)}
              className="mt-3 min-h-24 w-full rounded-md border border-white/10 bg-slate-950/40 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-400 outline-none focus-visible:ring-2 focus-visible:ring-amber-400"
              placeholder="Example: docker compose service for a FastAPI app that exposes port 8001, uses /app as the working directory, and writes logs to /var/log/app"
            />
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
              <p className="text-xs leading-5 text-amber-50/75">
                {migrationStatus ||
                  "This pre-fills the LaunchAgent form from a Docker or OrbStack service description. Save is still manual."}
              </p>
              <Button
                type="button"
                onClick={handleGenerateMigrationDraft}
                disabled={migrationDrafting || !runtimeReady}
                className="bg-amber-500 text-slate-950 hover:bg-amber-400"
              >
                {migrationDrafting ? "Migrating..." : "Migrate with AI"}
              </Button>
            </div>
          </div>
        )}

        <div className="grid gap-4 py-4">
          <div className="grid gap-1.5">
            <Label htmlFor="label">
              Label <span className="text-destructive">*</span>
            </Label>
            <Input
              id="label"
              placeholder="com.example.my-agent"
              value={config.label}
              onChange={(e) => {
                const label = e.target.value.replace(/\s/g, "")
                const updates: Partial<PlistConfig> = { label }
                if (!isEditing && homeDir && label.trim()) {
                  const logDir = `${homeDir}/Library/Logs/${APP_DIR_NAME}`
                  updates.standard_out_path = `${logDir}/${label}.stdout.log`
                  updates.standard_error_path = `${logDir}/${label}.stderr.log`
                }
                setConfig({ ...config, ...updates })
              }}
              disabled={isEditing}
              spellCheck={false}
              autoCorrect="off"
            />
            <p className="text-xs text-muted-foreground">
              Unique identifier for this agent. Use reverse domain notation (e.g. com.yourname.task).
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="args">
              Program Arguments <span className="text-destructive">*</span>
            </Label>
            <Input
              id="args"
              placeholder="/usr/bin/my-program --flag value"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              spellCheck={false}
              autoCorrect="off"
            />
            <p className="text-xs text-muted-foreground">
              The command to execute, followed by its arguments. Space-separated. Use quotes for arguments containing spaces (e.g. /usr/bin/cmd "arg with spaces").
            </p>
          </div>

          <div className="grid gap-3 rounded-md border bg-muted/20 p-3">
            <div>
              <h4 className="text-sm font-medium">Service Metadata</h4>
              <p className="mt-1 text-xs text-muted-foreground">
                Stored in the plist under LaunchControl for grouping and filtering.
              </p>
            </div>
            {!isEditing && (
              <div className="grid gap-1.5">
                <Label htmlFor="service-template">Service Template</Label>
                <Select
                  value={config.metadata.template ?? "custom"}
                  onValueChange={(value) => {
                    if (value === "custom") {
                      setConfig({
                        ...config,
                        metadata: {
                          ...config.metadata,
                          template: null,
                        },
                      })
                      return
                    }
                    applyServiceTemplate(value as ServiceTemplateKey)
                  }}
                >
                  <SelectTrigger id="service-template">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {serviceTemplateOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Start from a common local service shape, then adjust the command and metadata.
                </p>
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="metadata-group">Group</Label>
              <Input
                id="metadata-group"
                placeholder="CAISS System"
                value={config.metadata.group ?? ""}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    metadata: {
                      ...config.metadata,
                      group: e.target.value.trim() ? e.target.value : null,
                    },
                  })
                }
                spellCheck={false}
                autoCorrect="off"
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="metadata-tags">Tags</Label>
              <Input
                id="metadata-tags"
                placeholder="caiss, api, local-infra"
                value={config.metadata.tags.join(", ")}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    metadata: {
                      ...config.metadata,
                      tags: e.target.value
                        .split(",")
                        .map((tag) => tag.trim())
                        .filter(Boolean),
                    },
                  })
                }
                spellCheck={false}
                autoCorrect="off"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="metadata-environment">Environment</Label>
                <Input
                  id="metadata-environment"
                  placeholder="local"
                  value={config.metadata.environment ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      metadata: {
                        ...config.metadata,
                        environment: e.target.value.trim() ? e.target.value : null,
                      },
                    })
                  }
                  spellCheck={false}
                  autoCorrect="off"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="metadata-managed-by">Managed By</Label>
                <Input
                  id="metadata-managed-by"
                  placeholder={APP_NAME}
                  value={config.metadata.managed_by ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      metadata: {
                        ...config.metadata,
                        managed_by: e.target.value.trim() ? e.target.value : null,
                      },
                    })
                  }
                  spellCheck={false}
                  autoCorrect="off"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="metadata-description">Description</Label>
              <Input
                id="metadata-description"
                placeholder="Short service purpose"
                value={config.metadata.description ?? ""}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    metadata: {
                      ...config.metadata,
                      description: e.target.value.trim() ? e.target.value : null,
                    },
                  })
                }
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-1.5">
                <Label htmlFor="metadata-health-url">Health Check URL</Label>
                <Input
                  id="metadata-health-url"
                  placeholder="http://127.0.0.1:8001/health"
                  value={config.metadata.health_check_url ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      metadata: {
                        ...config.metadata,
                        health_check_url: e.target.value.trim() ? e.target.value : null,
                      },
                    })
                  }
                  spellCheck={false}
                  autoCorrect="off"
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="metadata-health-command">Health Check Command</Label>
                <Input
                  id="metadata-health-command"
                  placeholder="pgrep -f worker"
                  value={config.metadata.health_check_command ?? ""}
                  onChange={(e) =>
                    setConfig({
                      ...config,
                      metadata: {
                        ...config.metadata,
                        health_check_command: e.target.value.trim() ? e.target.value : null,
                      },
                    })
                  }
                  spellCheck={false}
                  autoCorrect="off"
                />
              </div>
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="metadata-ports">Ports</Label>
              <Input
                id="metadata-ports"
                placeholder="8001, 8002"
                value={config.metadata.ports.join(", ")}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    metadata: {
                      ...config.metadata,
                      ports: e.target.value
                        .split(",")
                        .map((port) => Number(port.trim()))
                        .filter((port) => Number.isFinite(port) && port > 0)
                        .map((port) => Math.trunc(port)),
                    },
                  })
                }
                spellCheck={false}
                autoCorrect="off"
              />
              <p className="text-xs text-muted-foreground">
                Used for dashboard visibility and migration tracking.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="run-at-load">Run at Load</Label>
              <Select
                value={config.run_at_load ? "true" : "false"}
                onValueChange={(v) =>
                  setConfig({ ...config, run_at_load: v === "true" })
                }
              >
                <SelectTrigger id="run-at-load">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Yes</SelectItem>
                  <SelectItem value="false">No</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Start automatically when loaded by launchd.
              </p>
            </div>

            <div className="grid gap-1.5">
              <Label htmlFor="keep-alive">Keep Alive</Label>
              <Select
                value={config.keep_alive ? "true" : "false"}
                onValueChange={(v) =>
                  setConfig({ ...config, keep_alive: v === "true" })
                }
              >
                <SelectTrigger id="keep-alive">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">Yes</SelectItem>
                  <SelectItem value="false">No</SelectItem>
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Restart automatically if the process exits.
              </p>
            </div>
          </div>

          <div className="grid gap-1.5">
            <Label>
              Schedule <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Select
              value={scheduleType}
              onValueChange={(v) => setScheduleType(v as JobFormScheduleType)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No schedule</SelectItem>
                <SelectItem value="interval">Run every N seconds</SelectItem>
                <SelectItem value="calendar">Run at specific time</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              How to trigger this agent. "No schedule" means manual start only.
            </p>
          </div>

          {scheduleType !== "calendar" && (
            <div className="rounded-md border border-dashed border-cyan-400/30 bg-cyan-400/5 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-xs font-medium uppercase tracking-[0.22em] text-cyan-100/80">
                    Calendar agent
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Choose a clock-based schedule for daily jobs, weekday jobs, or recurring hourly runs.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => applyCalendarPreset("daily")}>
                    Daily 9:00
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => applyCalendarPreset("weekday")}>
                    Weekdays 9:00
                  </Button>
                  <Button type="button" variant="outline" size="sm" onClick={() => applyCalendarPreset("hourly")}>
                    Every hour
                  </Button>
                </div>
              </div>
              <p className="mt-2 text-xs text-cyan-50/80">
                Pick one of the presets above, or set <span className="font-medium">Run at specific time</span> and edit minute, hour, weekday, and day below.
              </p>
            </div>
          )}

          {scheduleType === "interval" && (
            <div className="grid gap-1.5">
              <Label htmlFor="interval">Interval (seconds)</Label>
              <Input
                id="interval"
                type="number"
                placeholder="300"
                value={config.start_interval ?? ""}
                onChange={(e) =>
                  setConfig({
                    ...config,
                    start_interval: e.target.value
                      ? Number(e.target.value)
                      : null,
                  })
                }
              />
              <p className="text-xs text-muted-foreground">
                e.g. 300 = every 5 minutes, 3600 = every hour.
              </p>
              {config.start_interval && config.start_interval > 0 && (
                <div className="rounded-md border bg-muted/30 p-3">
                  <p className="text-xs font-medium text-muted-foreground mb-1.5">
                    Next runs
                  </p>
                  <ul className="space-y-0.5">
                    {[1, 2, 3].map((n) => {
                      const d = new Date(Date.now() + config.start_interval! * 1000 * n)
                      return (
                        <li key={n} className="text-sm font-mono">
                          {formatDateTime(d)}
                        </li>
                      )
                    })}
                  </ul>
                </div>
              )}
            </div>
          )}

          {scheduleType === "calendar" && (
            <div className="grid gap-4">
              <div className="grid gap-1.5">
                <Label>Hour</Label>
                <Select
                  value={hourMode}
                  onValueChange={(v) => {
                    const mode = v as JobFormHourMode
                    setHourMode(mode)
                    if (mode === "specific" && (calendarInterval.hour === null || calendarInterval.hour === undefined)) {
                      setCalendarInterval({ ...calendarInterval, hour: 9 })
                    }
                    if (mode === "every") {
                      setCalendarInterval({ ...calendarInterval, hour: null })
                    }
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="specific">Specific hour</SelectItem>
                    <SelectItem value="every">Every hour</SelectItem>
                    <SelectItem value="range">Hour range</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Use <span className="font-medium">Specific hour</span> for a daily calendar job like 9:00 AM, or <span className="font-medium">Every hour</span> / <span className="font-medium">Hour range</span> for repeating hourly runs.
                </p>
              </div>
              {hourMode === "specific" && (
                <div className="grid gap-1.5">
                  <Input
                    id="cal-hour"
                    type="number"
                    min={0}
                    max={23}
                    placeholder="9"
                    value={calendarInterval.hour ?? ""}
                    onChange={(e) =>
                      setCalendarInterval({
                        ...calendarInterval,
                        hour: e.target.value ? Number(e.target.value) : null,
                      })
                    }
                  />
                </div>
              )}
              {hourMode === "range" && (
                <div className="grid gap-1.5">
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      placeholder="7"
                      value={hourRange.from}
                      onChange={(e) =>
                        setHourRange({ ...hourRange, from: Number(e.target.value) })
                      }
                    />
                    <span className="text-sm text-muted-foreground whitespace-nowrap">to</span>
                    <Input
                      type="number"
                      min={0}
                      max={23}
                      placeholder="23"
                      value={hourRange.to}
                      onChange={(e) =>
                        setHourRange({ ...hourRange, to: Number(e.target.value) })
                      }
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Runs every hour within this range (e.g. 7 to 23 = runs at 7:00, 8:00, ... 23:00).
                  </p>
                </div>
              )}
              <div className="grid gap-1.5">
                <Label htmlFor="cal-minute">Minute</Label>
                <Input
                  id="cal-minute"
                  type="number"
                  min={0}
                  max={59}
                  placeholder="0"
                  value={calendarInterval.minute ?? ""}
                  onChange={(e) =>
                    setCalendarInterval({
                      ...calendarInterval,
                      minute: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Example: 30 with hour 9 means 9:30 AM every day unless you add a weekday or day-of-month.
                </p>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cal-weekday">
                  Weekday <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Select
                  value={calendarInterval.weekday !== null && calendarInterval.weekday !== undefined ? String(calendarInterval.weekday) : "any"}
                  onValueChange={(v) =>
                    setCalendarInterval({
                      ...calendarInterval,
                      weekday: v === "any" ? null : Number(v),
                    })
                  }
                >
                  <SelectTrigger id="cal-weekday">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Every day</SelectItem>
                    {weekdayLabels.map((label, i) => (
                      <SelectItem key={i} value={String(i)}>
                        {label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="cal-day">
                  Day of month <span className="text-xs font-normal text-muted-foreground">(optional)</span>
                </Label>
                <Input
                  id="cal-day"
                  type="number"
                  min={1}
                  max={31}
                  placeholder="Leave empty for every day"
                  value={calendarInterval.day ?? ""}
                  onChange={(e) =>
                    setCalendarInterval({
                      ...calendarInterval,
                      day: e.target.value ? Number(e.target.value) : null,
                    })
                  }
                />
              </div>
              <div className="grid gap-1.5">
                <Label htmlFor="wake-system">Wake System</Label>
                <Select
                  value={config.wake_system ? "true" : "false"}
                  onValueChange={(v) =>
                    setConfig({ ...config, wake_system: v === "true" })
                  }
                >
                  <SelectTrigger id="wake-system">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">Yes</SelectItem>
                    <SelectItem value="false">No</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Wake the system from sleep to run this agent at the scheduled time.
                </p>
              </div>
              <div className="rounded-md border bg-muted/30 p-3">
                <p className="text-xs font-medium text-muted-foreground mb-1.5">
                  Next runs ({Intl.DateTimeFormat().resolvedOptions().timeZone})
                </p>
                {(() => {
                  const intervals = hourMode === "range"
                    ? expandHourRange(calendarInterval, hourRange.from, hourRange.to)
                    : [calendarInterval]
                  if (intervals.length === 0) {
                    return <p className="text-xs text-destructive">Invalid hour range</p>
                  }
                  const occurrences = intervals.length > 1
                    ? getNextOccurrencesMulti(intervals, 3)
                    : getNextOccurrences(intervals[0], 3)
                  if (occurrences.length === 0) {
                    return <p className="text-xs text-muted-foreground">No upcoming runs found</p>
                  }
                  return (
                    <ul className="space-y-0.5">
                      {occurrences.map((d, i) => (
                        <li key={i} className="text-sm font-mono">
                          {formatDateTime(d)}
                        </li>
                      ))}
                    </ul>
                  )
                })()}
              </div>
            </div>
          )}

          <div className="grid gap-1.5">
            <Label htmlFor="working-dir">
              Working Directory <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="working-dir"
              placeholder="/path/to/working/directory"
              value={config.working_directory ?? ""}
              onChange={(e) =>
                setConfig({ ...config, working_directory: e.target.value })
              }
              spellCheck={false}
              autoCorrect="off"
            />
            <p className="text-xs text-muted-foreground">
              Directory to use as the current working directory when running the command.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="stdout">
              Standard Output Path <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="stdout"
              placeholder="/tmp/my-agent.stdout.log"
              value={config.standard_out_path ?? ""}
              onChange={(e) =>
                setConfig({ ...config, standard_out_path: e.target.value })
              }
              spellCheck={false}
              autoCorrect="off"
            />
            <p className="text-xs text-muted-foreground">
              File path to write the command's standard output. Useful for checking execution results.
            </p>
          </div>

          <div className="grid gap-1.5">
            <Label htmlFor="stderr">
              Standard Error Path <span className="text-xs font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="stderr"
              placeholder="/tmp/my-agent.stderr.log"
              value={config.standard_error_path ?? ""}
              onChange={(e) =>
                setConfig({ ...config, standard_error_path: e.target.value })
              }
              spellCheck={false}
              autoCorrect="off"
            />
            <p className="text-xs text-muted-foreground">
              File path to write the command's error output. Useful for debugging failures.
            </p>
          </div>

          {error && <div className="text-sm text-destructive">{error}</div>}
        </div>

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button type="button" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : isEditing ? "Save" : "Create"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
