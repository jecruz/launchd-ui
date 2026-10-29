import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TableCell, TableRow } from "@/components/ui/table"
import { deriveHealthText } from "@/lib/health"
import { CopyableInlineText } from "@/components/CopyableBlock"
import type { JobListEntry } from "@/types"
import {
  Play,
  Square,
  RotateCw,
  MoreHorizontal,
  Trash2,
  FileText,
  FolderOpen,
  Zap,
  Pencil,
} from "lucide-react"

function formatRelativeTime(epochMillis: string): string {
  const ms = Number(epochMillis)
  if (isNaN(ms)) return "—"
  const diff = Date.now() - ms
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return "just now"
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const date = new Date(ms)
  return `${date.getMonth() + 1}/${date.getDate()}`
}

type JobRowProps = {
  job: JobListEntry
  onStart: (job: JobListEntry) => void
  onStop: (job: JobListEntry) => void
  onRestart: (job: JobListEntry) => void
  onKickstart: (job: JobListEntry) => void
  onEdit: (job: JobListEntry) => void
  onDelete: (job: JobListEntry) => void
  onSelect: (job: JobListEntry) => void
  onRevealInFinder: (job: JobListEntry) => void
}

function StatusBadge({ status }: { status: JobListEntry["status"] }) {
  switch (status) {
    case "Running":
      return (
        <Badge variant="default" className="bg-emerald-500 hover:bg-emerald-600">
          Running
        </Badge>
      )
    case "Loaded":
      return (
        <Badge variant="default" className="bg-blue-500 hover:bg-blue-600">
          Loaded
        </Badge>
      )
    case "Unloaded":
      return <Badge variant="secondary">Unloaded</Badge>
    default:
      return <Badge variant="outline">Unknown</Badge>
  }
}

function SourceBadge({ source }: { source: JobListEntry["source"] }) {
  switch (source) {
    case "UserAgent":
      return <Badge variant="outline">User</Badge>
    case "SystemAgent":
      return (
        <Badge variant="outline" className="border-blue-300 text-blue-700">
          System
        </Badge>
      )
    case "SystemDaemon":
      return (
        <Badge variant="outline" className="border-purple-300 text-purple-700">
          Daemon
        </Badge>
      )
  }
}

function healthText(job: JobListEntry) {
  return deriveHealthText(job)
}

function logCoverage(job: JobListEntry) {
  const count = [job.log_paths.stdout, job.log_paths.stderr].filter(Boolean).length
  if (count === 2) return "2 logs"
  if (count === 1) return "1 log"
  return "No logs"
}

function portCoverage(job: JobListEntry) {
  if (job.metadata.ports.length === 0) return null
  return job.metadata.ports.slice(0, 3).map((port) => String(port))
}

export function JobRow({
  job,
  onStart,
  onStop,
  onRestart,
  onKickstart,
  onEdit,
  onDelete,
  onSelect,
  onRevealInFinder,
}: JobRowProps) {
  const isUserAgent = job.source === "UserAgent"

  return (
    <TableRow
      className="cursor-pointer hover:bg-muted/50"
      onClick={() => onSelect(job)}
    >
      <TableCell className="font-medium max-w-[18rem]">
        <div onClick={(event) => event.stopPropagation()}>
          <CopyableInlineText
            text={job.label}
            copyLabel={`Copy label ${job.label}`}
            className="w-full justify-start font-medium"
          />
        </div>
        {job.metadata.description && (
          <div className="mt-1 truncate text-xs font-normal text-muted-foreground">
            {job.metadata.description}
          </div>
        )}
      </TableCell>
      <TableCell className="max-w-[12rem]">
        <div className="truncate text-sm">
          {job.metadata.group ?? "Ungrouped"}
        </div>
        {job.metadata.tags.length > 0 && (
          <div className="mt-1 flex max-w-full flex-wrap gap-1">
            {job.metadata.tags.slice(0, 2).map((tag) => (
              <Badge key={tag} variant="outline" className="px-1.5 py-0 text-[10px]">
                {tag}
              </Badge>
            ))}
            {job.metadata.tags.length > 2 && (
              <span className="text-[10px] text-muted-foreground">+{job.metadata.tags.length - 2}</span>
            )}
          </div>
        )}
        {portCoverage(job) && (
          <div className="mt-1 flex flex-wrap gap-1">
            {portCoverage(job)?.map((port) => (
              <Badge key={port} variant="secondary" className="px-1.5 py-0 text-[10px]">
                {port}
              </Badge>
            ))}
          </div>
        )}
      </TableCell>
      <TableCell>
        <SourceBadge source={job.source} />
      </TableCell>
      <TableCell>
        <StatusBadge status={job.status} />
      </TableCell>
      <TableCell className="text-muted-foreground tabular-nums">
        {job.pid ?? "—"}
      </TableCell>
      <TableCell className="text-muted-foreground text-xs tabular-nums">
        {job.last_run_at ? formatRelativeTime(job.last_run_at) : "—"}
      </TableCell>
      <TableCell>
        <div className="text-xs">
          <div
            className={[
              "font-medium",
              healthText(job) === "Attention"
                ? "text-rose-500"
                : healthText(job) === "Running"
                  ? "text-emerald-600"
                  : "text-muted-foreground",
            ].join(" ")}
          >
            {healthText(job)}
          </div>
          <div className="text-muted-foreground">{logCoverage(job)}</div>
        </div>
      </TableCell>
      <TableCell className="sticky right-0 z-10 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="flex items-center justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {job.status === "Running" ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onStop(job)}
              disabled={!isUserAgent}
              title={isUserAgent ? "Stop" : "Cannot stop system agents"}
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : job.status === "Loaded" ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onStop(job)}
              disabled={!isUserAgent}
              title={isUserAgent ? "Unload" : "Cannot unload system agents"}
            >
              <Square className="h-4 w-4" />
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onStart(job)}
              disabled={!isUserAgent}
              title={isUserAgent ? "Load" : "Cannot load system agents"}
            >
              <Play className="h-4 w-4" />
            </Button>
          )}
          {job.status !== "Unloaded" && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8"
              onClick={() => onRestart(job)}
              disabled={!isUserAgent}
              title={isUserAgent ? "Restart" : "Cannot restart system agents"}
            >
              <RotateCw className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onEdit(job)}
            disabled={!isUserAgent}
            title={isUserAgent ? "Edit" : "Cannot edit system agents"}
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => onDelete(job)}
            disabled={!isUserAgent}
            title={isUserAgent ? "Delete" : "Cannot delete system agents"}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8">
                <MoreHorizontal className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => onKickstart(job)}>
                <Zap className="mr-2 h-4 w-4" />
                Test Run
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSelect(job)}>
                <FileText className="mr-2 h-4 w-4" />
                Details
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onRevealInFinder(job)}>
                <FolderOpen className="mr-2 h-4 w-4" />
                Reveal in Finder
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </TableCell>
    </TableRow>
  )
}
