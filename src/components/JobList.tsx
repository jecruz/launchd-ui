import { useMemo, useState } from "react"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { JobRow } from "@/components/JobRow"
import { Button } from "@/components/ui/button"
import type { JobListEntry } from "@/types"
import { deriveHealthText } from "@/lib/health"

type JobListProps = {
  jobs: JobListEntry[]
  loading: boolean
  onStart: (job: JobListEntry) => void
  onStop: (job: JobListEntry) => void
  onRestart: (job: JobListEntry) => void
  onKickstart: (job: JobListEntry) => void
  onEdit: (job: JobListEntry) => void
  onDelete: (job: JobListEntry) => void
  onSelect: (job: JobListEntry) => void
  onRevealInFinder: (job: JobListEntry) => void
}

type SortKey = "label" | "group" | "source" | "status" | "pid" | "last_run_at" | "health"
type SortDirection = "asc" | "desc"

const sourceOrder: Record<JobListEntry["source"], number> = {
  UserAgent: 0,
  SystemAgent: 1,
  SystemDaemon: 2,
}

const statusOrder: Record<JobListEntry["status"], number> = {
  Running: 0,
  Loaded: 1,
  Unloaded: 2,
  Unknown: 3,
}

const healthOrder: Record<string, number> = {
  Healthy: 0,
  Running: 1,
  Loaded: 2,
  Idle: 3,
  Attention: 4,
}

function compareStrings(a: string, b: string, direction: SortDirection) {
  const comparison = a.localeCompare(b, undefined, {
    sensitivity: "base",
    numeric: true,
  })
  return direction === "asc" ? comparison : -comparison
}

function compareNullableNumbers(a: number | null, b: number | null, direction: SortDirection) {
  if (a === null && b === null) return 0
  if (a === null) return 1
  if (b === null) return -1
  return direction === "asc" ? a - b : b - a
}

function compareHealth(jobA: JobListEntry, jobB: JobListEntry, direction: SortDirection) {
  const a = healthOrder[deriveHealthText(jobA)] ?? Number.MAX_SAFE_INTEGER
  const b = healthOrder[deriveHealthText(jobB)] ?? Number.MAX_SAFE_INTEGER
  const comparison = a - b
  if (comparison !== 0) {
    return direction === "asc" ? comparison : -comparison
  }
  return compareStrings(jobA.label, jobB.label, direction)
}

function parseTimestamp(value: string | null): number | null {
  if (value === null) return null
  const parsed = Number(value)
  return Number.isNaN(parsed) ? null : parsed
}

function compareJobs(a: JobListEntry, b: JobListEntry, key: SortKey, direction: SortDirection) {
  switch (key) {
    case "label":
      return compareStrings(a.label, b.label, direction)
    case "group":
      return compareStrings(a.metadata.group ?? "Ungrouped", b.metadata.group ?? "Ungrouped", direction)
    case "source":
      return compareNullableNumbers(sourceOrder[a.source], sourceOrder[b.source], direction)
    case "status":
      return compareNullableNumbers(statusOrder[a.status], statusOrder[b.status], direction)
    case "pid":
      return compareNullableNumbers(a.pid, b.pid, direction)
    case "last_run_at":
      return compareNullableNumbers(
        parseTimestamp(a.last_run_at),
        parseTimestamp(b.last_run_at),
        direction
      )
    case "health":
      return compareHealth(a, b, direction)
  }
}

function SortButton({
  label,
  active,
  direction,
  onClick,
}: {
  label: string
  active: boolean
  direction: SortDirection
  onClick: () => void
}) {
  const icon =
    !active ? (
      <ArrowUpDown className="h-3.5 w-3.5" />
    ) : direction === "asc" ? (
      <ArrowUp className="h-3.5 w-3.5" />
    ) : (
      <ArrowDown className="h-3.5 w-3.5" />
    )

  return (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="h-auto px-0 py-0 font-medium text-inherit hover:bg-transparent hover:text-foreground"
      onClick={onClick}
      aria-label={`Sort by ${label}`}
      aria-pressed={active}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        <span className="text-muted-foreground">{icon}</span>
      </span>
    </Button>
  )
}

export function JobList({
  jobs,
  loading,
  onStart,
  onStop,
  onRestart,
  onKickstart,
  onEdit,
  onDelete,
  onSelect,
  onRevealInFinder,
}: JobListProps) {
  const [sortKey, setSortKey] = useState<SortKey>("health")
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc")

  const sortedJobs = useMemo(() => {
    return [...jobs].sort((a, b) => compareJobs(a, b, sortKey, sortDirection))
  }, [jobs, sortKey, sortDirection])

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) {
      setSortDirection((current) => (current === "asc" ? "desc" : "asc"))
      return
    }
    setSortKey(key)
    setSortDirection("asc")
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        Loading agents...
      </div>
    )
  }

  if (jobs.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
        No agents found
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead aria-sort={sortKey === "label" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}>
            <SortButton
              label="Label"
              active={sortKey === "label"}
              direction={sortDirection}
              onClick={() => toggleSort("label")}
            />
          </TableHead>
          <TableHead
            className="w-36"
            aria-sort={sortKey === "group" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
          >
            <SortButton
              label="Group"
              active={sortKey === "group"}
              direction={sortDirection}
              onClick={() => toggleSort("group")}
            />
          </TableHead>
          <TableHead
            className="w-24"
            aria-sort={sortKey === "source" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
          >
            <SortButton
              label="Source"
              active={sortKey === "source"}
              direction={sortDirection}
              onClick={() => toggleSort("source")}
            />
          </TableHead>
          <TableHead
            className="w-24"
            aria-sort={sortKey === "status" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
          >
            <SortButton
              label="Status"
              active={sortKey === "status"}
              direction={sortDirection}
              onClick={() => toggleSort("status")}
            />
          </TableHead>
          <TableHead
            className="w-16"
            aria-sort={sortKey === "pid" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
          >
            <SortButton
              label="PID"
              active={sortKey === "pid"}
              direction={sortDirection}
              onClick={() => toggleSort("pid")}
            />
          </TableHead>
          <TableHead
            className="w-24"
            aria-sort={
              sortKey === "last_run_at" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"
            }
          >
            <SortButton
              label="Last Run"
              active={sortKey === "last_run_at"}
              direction={sortDirection}
              onClick={() => toggleSort("last_run_at")}
            />
          </TableHead>
          <TableHead
            className="w-24"
            aria-sort={sortKey === "health" ? (sortDirection === "asc" ? "ascending" : "descending") : "none"}
          >
            <SortButton
              label="Health"
              active={sortKey === "health"}
              direction={sortDirection}
              onClick={() => toggleSort("health")}
            />
          </TableHead>
          <TableHead className="sticky right-0 z-20 w-44 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
            Actions
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sortedJobs.map((job) => (
          <JobRow
            key={job.plist_path}
            job={job}
            onStart={onStart}
            onStop={onStop}
            onRestart={onRestart}
            onKickstart={onKickstart}
            onEdit={onEdit}
            onDelete={onDelete}
            onSelect={onSelect}
            onRevealInFinder={onRevealInFinder}
          />
        ))}
      </TableBody>
    </Table>
  )
}
