import { useState, useCallback, useRef, useEffect } from "react"
import { readLogFile } from "@/lib/invoke"

function stripAnsiAndControl(text: string): string {
  return text
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
}

type UseLogsReturn = {
  content: string
  modifiedAt: Date | null
  loading: boolean
  error: string | null
  fetchLog: (path: string, tailLines?: number) => Promise<void>
}

export function useLogs(): UseLogsReturn {
  const [content, setContent] = useState("")
  const [modifiedAt, setModifiedAt] = useState<Date | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const request = useRef(0)
  useEffect(() => () => { request.current += 1 }, [])
  const fetchLog = useCallback(async (path: string, tailLines?: number) => {
    const generation = ++request.current
    setContent("")
    setModifiedAt(null)
    setLoading(true)
    setError(null)
    try {
      const result = await readLogFile(path, tailLines)
      if (generation !== request.current) return
      setContent(stripAnsiAndControl(result.content))
      const modified = result.modified_at ? new Date(Number(result.modified_at)) : null
      setModifiedAt(modified && Number.isFinite(modified.getTime()) ? modified : null)
    } catch (e) {
      if (generation !== request.current) return
      setError(String(e))
      setContent("")
      setModifiedAt(null)
    } finally {
      if (generation === request.current) setLoading(false)
    }
  }, [])

  return { content, modifiedAt, loading, error, fetchLog }
}
