import { useCallback, useEffect, useRef, useState } from "react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { LogViewer } from "@/components/LogViewer"
import { CopyableCodeBlock, CopyableInlineText } from "@/components/CopyableBlock"
import { deriveHealthText } from "@/lib/health"
import { formatEpochMillis24 } from "@/lib/time"
import type { LaunchdJob, ServiceDiagnosis, ServiceRepairSuggestion } from "@/types"
import {
  checkServiceHealth,
  diagnoseService,
  getJobDetail,
  revealInFinder,
  saveJob,
} from "@/lib/invoke"
import { AlertTriangle, CheckCircle2, FolderOpen, Wrench } from "lucide-react"
import { formatCalendarIntervals } from "@/lib/calendar-utils"

type JobDetailProps = {
  plistPath: string | null
  open: boolean
  onClose: () => void
  onEdit: (job: LaunchdJob) => void
  onRepair: (job: LaunchdJob, diagnosis: ServiceDiagnosis | null) => void
}

function DetailRow({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) return null
  return (
    <div className="grid grid-cols-3 gap-2 py-1.5">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="col-span-2 text-sm font-mono break-all">{value}</dd>
    </div>
  )
}

function healthLabel(job: LaunchdJob) {
  const text = deriveHealthText({
    status: job.status,
    last_exit_code: job.last_exit_code,
    metadata: job.plist.metadata,
  })
  if (text === "Healthy") return "Healthy"
  if (text === "Attention") return "Needs attention"
  return text
}

function hasExplicitHealthCheck(job: LaunchdJob) {
  return Boolean(job.plist.metadata.health_check_url || job.plist.metadata.health_check_command)
}

const suggestionKindOrder: Record<string, number> = {
  metadata: 0,
  template: 1,
  plist: 2,
}

function sortLikelyCauses(likelyCauses: string[]) {
  return [...likelyCauses].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
}

function sortSuggestions(suggestions: ServiceRepairSuggestion[]) {
  return [...suggestions].sort((a, b) => {
    const kindA = suggestionKindOrder[a.kind] ?? Number.MAX_SAFE_INTEGER
    const kindB = suggestionKindOrder[b.kind] ?? Number.MAX_SAFE_INTEGER
    if (kindA !== kindB) return kindA - kindB
    const titleComparison = a.title.localeCompare(b.title, undefined, { sensitivity: "base" })
    if (titleComparison !== 0) return titleComparison
    return a.detail.localeCompare(b.detail, undefined, { sensitivity: "base" })
  })
}

/** Present one selected job and ignore asynchronous results for previous selections. */
export function JobDetail({ plistPath, open, onClose, onEdit, onRepair }: JobDetailProps) {
  const [loadedJob, setJob] = useState<LaunchdJob | null>(null)
  const job = loadedJob?.plist_path === plistPath && open ? loadedJob : null
  const [loading, setLoading] = useState(false)
  const [checkingHealth, setCheckingHealth] = useState(false)
  const [healthMessage, setHealthMessage] = useState<string | null>(null)
  const [diagnosisLoading, setDiagnosisLoading] = useState(false)
  const [diagnosisError, setDiagnosisError] = useState<string | null>(null)
  const [diagnosis, setDiagnosis] = useState<ServiceDiagnosis | null>(null)
  const selection = useRef({ key: `${open}:${plistPath}`, generation: 0 })
  const key = `${open}:${plistPath}`
  if (selection.current.key !== key) selection.current = { key, generation: selection.current.generation + 1 }
  const diagnosisRequest = useRef(0)

  const fetchDiagnosis = useCallback(async (path: string, generation: number) => {
    const request = ++diagnosisRequest.current
    const current = () => selection.current.generation === generation && request === diagnosisRequest.current
    setDiagnosisLoading(true)
    setDiagnosisError(null)
    try {
      const result = await diagnoseService(path)
      if (current()) setDiagnosis(result)
    } catch (error) {
      if (current()) { setDiagnosisError(String(error)); setDiagnosis(null) }
    } finally {
      if (current()) setDiagnosisLoading(false)
    }
  }, [])

  useEffect(() => {
    const generation = selection.current.generation
    const current = () => selection.current.generation === generation
    setJob(null)
    setDiagnosis(null)
    setHealthMessage(null)
    setDiagnosisError(null)
    setCheckingHealth(false)
    setDiagnosisLoading(false)
    if (!plistPath || !open) { setLoading(false); return }
    setLoading(true)
    void getJobDetail(plistPath).then(async (loaded) => {
      if (!current()) return
      setJob(loaded)
      await fetchDiagnosis(plistPath, generation)
    }).catch((error) => { if (current()) setDiagnosisError(String(error)) })
      .finally(() => { if (current()) setLoading(false) })
    return () => { selection.current.generation += 1 }
  }, [plistPath, open, fetchDiagnosis])

  const handleCheckHealth = async () => {
    if (!job) return
    const generation = selection.current.generation
    const current = () => selection.current.generation === generation
    setCheckingHealth(true)
    setHealthMessage(null)
    try {
      const result = await checkServiceHealth(job.plist_path)
      if (!current()) return
      setHealthMessage(`${result.status}: ${result.detail}`)
      const refreshed = await getJobDetail(job.plist_path)
      if (!current()) return
      setJob(refreshed)
      await fetchDiagnosis(job.plist_path, generation)
    } catch (error) {
      if (current()) setHealthMessage(String(error))
    } finally {
      if (current()) setCheckingHealth(false)
    }
  }

  const handleRefreshDiagnosis = async () => {
    if (job) await fetchDiagnosis(job.plist_path, selection.current.generation)
  }

  const handleApplySuggestedMetadata = async () => {
    if (!job || job.source !== "UserAgent" || !diagnosis?.suggested_metadata) return
    const generation = selection.current.generation
    const current = () => selection.current.generation === generation
    setCheckingHealth(true)
    try {
      await saveJob(job.plist_path, { ...job.plist, metadata: { ...job.plist.metadata, ...diagnosis.suggested_metadata } })
      if (!current()) return
      await checkServiceHealth(job.plist_path)
      if (!current()) return
      const refreshed = await getJobDetail(job.plist_path)
      if (!current()) return
      setJob(refreshed)
      await fetchDiagnosis(job.plist_path, generation)
    } catch (error) {
      if (current()) setDiagnosisError(String(error))
    } finally {
      if (current()) setCheckingHealth(false)
    }
  }

  const noExplicitHealthCheck =
    Boolean(job) &&
    (job?.plist.metadata.health_status === "unknown" || job?.plist.metadata.health_status == null) &&
    !(job && hasExplicitHealthCheck(job))
  const showRepairButton =
    job?.source === "UserAgent" &&
    Boolean(diagnosis?.suggested_metadata || (diagnosis?.suggestions?.length ?? 0) > 0)
  const hasRepairSignals =
    Boolean(diagnosis) &&
    (diagnosis?.health_status === "unhealthy" ||
      (diagnosis?.likely_causes?.length ?? 0) > 0 ||
      (diagnosis?.suggestions?.length ?? 0) > 0)
  const repairSectionTitle = noExplicitHealthCheck || !hasRepairSignals ? "Health" : "Repair"
  const likelyCauses = diagnosis ? sortLikelyCauses(diagnosis.likely_causes) : []
  const suggestions = diagnosis ? sortSuggestions(diagnosis.suggestions) : []

  return (
    <Sheet open={open} onOpenChange={(isOpen) => !isOpen && onClose()}>
      <SheetContent className="w-[600px] sm:w-[640px] sm:max-w-[640px] overflow-y-auto p-0">
        <SheetHeader>
          <SheetTitle className="text-base font-semibold">
            {job ? (
              <CopyableInlineText
                text={job.label}
                copyLabel={`Copy label ${job.label}`}
                className="text-base font-semibold"
              />
            ) : (
              "Loading..."
            )}
          </SheetTitle>
        </SheetHeader>

        {loading && (
          <div className="px-4 py-8 text-center text-muted-foreground">Loading...</div>
        )}

        {job && !loading && (
          <div className="space-y-4 px-4 pb-4">
            <div className="flex items-center gap-2">
              <Badge
                variant={job.status === "Running" || job.status === "Loaded" ? "default" : "secondary"}
                className={
                  job.status === "Running" ? "bg-emerald-500" :
                  job.status === "Loaded" ? "bg-blue-500" : ""
                }
              >
                {job.status}
              </Badge>
              {job.pid && (
                <span className="text-xs text-muted-foreground">PID: {job.pid}</span>
              )}
              {job.last_exit_code !== null && job.last_exit_code !== undefined && (
                <span className="text-xs text-muted-foreground">
                  Exit: {job.last_exit_code}
                </span>
              )}
              {job.last_run_at && (
                <span className="text-xs text-muted-foreground">
                  Last run: {formatEpochMillis24(job.last_run_at)}
                </span>
              )}
            </div>

            <div className="grid gap-2 rounded-md border bg-muted/20 p-3 sm:grid-cols-3">
              <div>
                <p className="text-xs text-muted-foreground">Health</p>
                <p className="mt-1 text-sm font-medium">{healthLabel(job)}</p>
                {job.plist.metadata.last_health_check_at && (
                  <p className="text-xs text-muted-foreground">
                    Last checked: {formatEpochMillis24(job.plist.metadata.last_health_check_at)}
                  </p>
                )}
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Log Paths</p>
                <p className="mt-1 text-sm font-medium">
                  {[job.plist.standard_out_path, job.plist.standard_error_path].filter(Boolean).length}/2
                </p>
              </div>
              <div>
                <p className="text-xs text-muted-foreground">Group</p>
                <p className="mt-1 truncate text-sm font-medium">
                  {job.plist.metadata.group ?? "Ungrouped"}
                </p>
                {job.plist.metadata.ports.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Ports: {job.plist.metadata.ports.join(", ")}
                  </p>
                )}
              </div>
            </div>

            <div className="flex gap-2">
              {job.source === "UserAgent" && (
                <Button size="sm" variant="outline" onClick={() => onEdit(job)}>
                  Edit
                </Button>
              )}
              <Button size="sm" variant="outline" onClick={handleCheckHealth} disabled={checkingHealth}>
                {checkingHealth ? "Checking..." : "Check Health"}
              </Button>
              <Button size="sm" variant="outline" onClick={handleRefreshDiagnosis} disabled={diagnosisLoading}>
                {diagnosisLoading ? "Diagnosing..." : "Diagnose"}
              </Button>
              {job.source === "UserAgent" && diagnosis?.suggested_metadata && (
                <Button size="sm" variant="secondary" onClick={handleApplySuggestedMetadata}>
                  <Wrench className="h-3 w-3 mr-1" />
                  Apply Suggested Fix
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                onClick={() => revealInFinder(job.plist_path)}
              >
                <FolderOpen className="h-3 w-3 mr-1" />
                Reveal
              </Button>
            </div>

            <Separator />

            <section className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{repairSectionTitle}</h3>
                {diagnosisLoading && (
                  <span className="text-xs text-muted-foreground">Analyzing logs and metadata...</span>
                )}
              </div>
              {diagnosisError && (
                <div className="rounded-md border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-200">
                  {diagnosisError}
                </div>
              )}
              {diagnosis ? (
                <div
                  className={
                    repairSectionTitle === "Repair"
                      ? "space-y-3 rounded-md border bg-muted/20 p-3"
                      : "space-y-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3"
                  }
                >
                  {noExplicitHealthCheck && (
                    <div className="space-y-3 rounded-md border border-amber-500/30 bg-amber-500/10 p-3">
                      <div className="flex items-start gap-2">
                        <Badge variant="outline" className="border-amber-500/40 text-amber-700">
                          No health check
                        </Badge>
                        <div className="text-sm">
                          <p className="font-medium">No explicit health check is configured.</p>
                          <p className="text-muted-foreground">
                            Add a Health Check URL or command to turn this into a probe-backed status.
                          </p>
                        </div>
                      </div>
                      {showRepairButton && (
                        <div className="flex">
                          <Button size="sm" variant="outline" onClick={() => onRepair(job, diagnosis)}>
                            <Wrench className="h-3 w-3 mr-1" />
                            Repair
                          </Button>
                        </div>
                      )}
                    </div>
                  )}
                  {!noExplicitHealthCheck && (
                    <div className="flex items-start gap-2">
                      {repairSectionTitle === "Repair" ? (
                        <AlertTriangle className="mt-0.5 h-4 w-4 text-amber-500" />
                      ) : (
                        <CheckCircle2 className="mt-0.5 h-4 w-4 text-emerald-500" />
                      )}
                      <div>
                        <p className="text-sm font-medium">{diagnosis.summary}</p>
                        {diagnosis.health_status && (
                          <p className="text-xs text-muted-foreground break-words">
                            Health: {diagnosis.health_status}
                            {diagnosis.health_detail ? ` · ${diagnosis.health_detail}` : ""}
                          </p>
                        )}
                      </div>
                    </div>
                  )}
                  {likelyCauses.length > 0 && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        Likely causes
                      </p>
                      <ul className="mt-2 space-y-1 text-sm">
                        {likelyCauses.map((cause) => (
                          <li key={cause} className="rounded border bg-background px-2 py-1">
                            {cause}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {suggestions.length > 0 && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        Suggested fixes
                      </p>
                      <ul className="mt-2 space-y-2">
                        {suggestions.map((suggestion) => (
                          <li key={suggestion.title} className="rounded border bg-background px-2 py-2">
                            <div className="text-sm font-medium">{suggestion.title}</div>
                            <div className="text-sm text-muted-foreground">{suggestion.detail}</div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {diagnosis.stderr_excerpt && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        stderr excerpt
                      </p>
                      <CopyableCodeBlock
                        text={diagnosis.stderr_excerpt}
                        copyLabel="Copy stderr excerpt"
                        className="mt-2"
                      >
                        <pre className="max-h-40 overflow-auto rounded border bg-background p-2 text-xs whitespace-pre-wrap">
                          {diagnosis.stderr_excerpt}
                        </pre>
                      </CopyableCodeBlock>
                    </div>
                  )}
                  {diagnosis.stdout_excerpt && (
                    <div>
                      <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">
                        stdout excerpt
                      </p>
                      <CopyableCodeBlock
                        text={diagnosis.stdout_excerpt}
                        copyLabel="Copy stdout excerpt"
                        className="mt-2"
                      >
                        <pre className="max-h-40 overflow-auto rounded border bg-background p-2 text-xs whitespace-pre-wrap">
                          {diagnosis.stdout_excerpt}
                        </pre>
                      </CopyableCodeBlock>
                    </div>
                  )}
                </div>
              ) : (
                <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
                  Run Diagnose to inspect logs, health, and likely repair paths.
                </div>
              )}
            </section>

            <Tabs defaultValue="config">
              <TabsList>
                <TabsTrigger value="config">Configuration</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
              </TabsList>

            <TabsContent value="config" className="space-y-1">
                <dl>
                  <DetailRow label="Label" value={job.plist.label} />
                  <DetailRow label="Group" value={job.plist.metadata.group ?? "Ungrouped"} />
                  <DetailRow label="Description" value={job.plist.metadata.description} />
                  <DetailRow label="Environment" value={job.plist.metadata.environment} />
                  <DetailRow label="Managed By" value={job.plist.metadata.managed_by} />
                  <DetailRow label="Template" value={job.plist.metadata.template} />
                  <DetailRow
                    label="Health Check URL"
                    value={job.plist.metadata.health_check_url}
                  />
                  <DetailRow
                    label="Health Check Command"
                    value={job.plist.metadata.health_check_command}
                  />
                  <DetailRow
                    label="Ports"
                    value={job.plist.metadata.ports.length > 0 ? job.plist.metadata.ports.join(", ") : null}
                  />
                  {job.plist.metadata.tags.length > 0 && (
                    <div className="grid grid-cols-3 gap-2 py-1.5">
                      <dt className="text-sm text-muted-foreground">Tags</dt>
                      <dd className="col-span-2 flex flex-wrap gap-1">
                        {job.plist.metadata.tags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </dd>
                    </div>
                  )}
                  <DetailRow label="Program" value={job.plist.program} />
                  {job.plist.program_arguments && job.plist.program_arguments.length > 0 && (
                    <div className="grid grid-cols-3 gap-2 py-1.5">
                      <dt className="text-sm text-muted-foreground">Arguments</dt>
                      <dd className="col-span-2 space-y-0.5">
                        {job.plist.program_arguments.map((arg, i) => (
                          <div key={i} className="text-sm font-mono break-all">
                            <span className="text-muted-foreground mr-1">[{i}]</span>
                            {arg}
                          </div>
                        ))}
                      </dd>
                    </div>
                  )}
                  {job.plist.run_at_load && (
                    <DetailRow label="Run at Load" value="true" />
                  )}
                  {job.plist.keep_alive && (
                    <DetailRow label="Keep Alive" value="true" />
                  )}
                  <DetailRow
                    label="Interval"
                    value={
                      job.plist.start_interval
                        ? `${job.plist.start_interval}s`
                        : undefined
                    }
                  />
                  <DetailRow
                    label="Working Dir"
                    value={job.plist.working_directory}
                  />
                  <DetailRow label="Stdout" value={job.plist.standard_out_path} />
                  <DetailRow label="Stderr" value={job.plist.standard_error_path} />
                  {job.plist.wake_system && (
                    <DetailRow label="Wake System" value="true" />
                  )}
                  {job.plist.disabled && (
                    <DetailRow label="Disabled" value="true" />
                  )}
                </dl>
                {job.plist.environment_variables &&
                  Object.keys(job.plist.environment_variables).length > 0 && (
                    <>
                      <Separator />
                      <h4 className="text-sm font-medium pt-2">
                        Environment Variables
                      </h4>
                      <dl>
                        {Object.entries(job.plist.environment_variables).map(
                          ([key, value]) => (
                            <DetailRow key={key} label={key} value={value} />
                          )
                        )}
                      </dl>
                    </>
                  )}
                {job.plist.start_calendar_interval &&
                  job.plist.start_calendar_interval.length > 0 && (
                    <>
                      <Separator />
                      <h4 className="text-sm font-medium pt-2">Schedule</h4>
                      <div className="text-sm py-0.5">
                        {formatCalendarIntervals(job.plist.start_calendar_interval)}
                      </div>
                    </>
                  )}
                {healthMessage && (
                  <>
                    <Separator />
                    <p className="text-sm text-muted-foreground break-words whitespace-pre-wrap">
                      {healthMessage}
                    </p>
                  </>
                )}
              </TabsContent>

              <TabsContent value="logs">
                <div className="space-y-4">
                  {job.plist.standard_out_path && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">Standard Output</h4>
                      <LogViewer logPath={job.plist.standard_out_path} plistPath={job.plist_path} readOnly={job.source !== "UserAgent"} />
                    </div>
                  )}
                  {job.plist.standard_error_path && (
                    <div>
                      <h4 className="text-sm font-medium mb-2">Standard Error</h4>
                      <LogViewer logPath={job.plist.standard_error_path} plistPath={job.plist_path} readOnly={job.source !== "UserAgent"} />
                    </div>
                  )}
                  {!job.plist.standard_out_path &&
                    !job.plist.standard_error_path && (
                      <div className="text-sm text-muted-foreground py-4">
                        No log paths configured for this agent
                      </div>
                    )}
                </div>
              </TabsContent>
            </Tabs>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}
