import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { CopyableCodeBlock, CopyableInlineText } from "@/components/CopyableBlock"
import { useLogs } from "@/hooks/useLogs"
import { clearLogFile, openLogInEditor } from "@/lib/invoke"
import { ExternalLink, RefreshCw, Trash2 } from "lucide-react"

type LogViewerProps = {
  logPath: string | null
  plistPath: string
  readOnly?: boolean
  tailLines?: number
}

function formatTime(date: Date): string {
  const h = String(date.getHours()).padStart(2, "0")
  const m = String(date.getMinutes()).padStart(2, "0")
  const s = String(date.getSeconds()).padStart(2, "0")
  const month = date.getMonth() + 1
  const day = date.getDate()
  return `${month}/${day} ${h}:${m}:${s}`
}

/** Show a job's logs and allow clearing only for mutable user agents. */
export function LogViewer({ logPath, plistPath, readOnly = false, tailLines = 200 }: LogViewerProps) {
  const [clearError, setClearError] = useState<string | null>(null)
  const { content, modifiedAt, loading, error, fetchLog } = useLogs()

  useEffect(() => {
    setClearError(null)
    if (logPath) {
      fetchLog(logPath, plistPath, tailLines)
    }
  }, [logPath, plistPath, tailLines, fetchLog])

  if (!logPath) {
    return (
      <div className="text-sm text-muted-foreground py-4">
        No log path configured
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 min-w-0">
          <CopyableInlineText
            text={logPath}
            copyLabel="Copy log path"
            className="text-xs text-muted-foreground font-mono"
          />
          {modifiedAt && (
            <span className="text-xs text-muted-foreground shrink-0">
              ({formatTime(modifiedAt)})
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => fetchLog(logPath, plistPath, tailLines)}
            disabled={loading}
          >
            <RefreshCw className={`h-3 w-3 mr-1 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              setClearError(null)
              try { await clearLogFile(logPath, plistPath); await fetchLog(logPath, plistPath, tailLines) }
              catch (error) { setClearError(String(error)) }
            }}
            disabled={readOnly || loading}
          >
            <Trash2 className="h-3 w-3 mr-1" />
            Clear
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => openLogInEditor(logPath)}
          >
            <ExternalLink className="h-3 w-3 mr-1" />
            Open in Editor
          </Button>
        </div>
      </div>
      {clearError && <div role="alert" className="text-sm text-destructive">{clearError}</div>}
      {error ? (
        <div className="text-sm text-destructive">{error}</div>
      ) : (
        <CopyableCodeBlock
          text={content}
          copyLabel="Copy log text"
          className="h-64"
        >
          <ScrollArea className="h-64 rounded-md border bg-muted/30">
            <pre className="p-3 text-xs font-mono whitespace-pre-wrap break-all">
              {content || "(empty)"}
            </pre>
          </ScrollArea>
        </CopyableCodeBlock>
      )}
    </div>
  )
}
