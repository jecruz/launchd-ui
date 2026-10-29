/** Coalesce preference changes and serialize saves, retaining failures for an explicit retry. */
export function createPreferenceWriter<T>(save: (value: T) => Promise<unknown>, report: (message: string | null) => void) {
  let pending: T | undefined
  let active: Promise<void> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): Promise<void> => {
    clearTimeout(timer)
    if (active) return active.then(() => flush())
    if (pending === undefined) return Promise.resolve()
    active = (async () => {
      while (pending !== undefined) {
        const snapshot = pending
        pending = undefined
        try {
          await save(snapshot)
          report(null)
        } catch (error) {
          if (pending === undefined) pending = snapshot
          report(`Preferences could not be saved: ${String(error)}`)
          throw error
        }
      }
    })().finally(() => { active = undefined })
    return active
  }

  return {
    /** Queue the latest snapshot, replacing any snapshot that has not started saving. */
    schedule(value: T) {
      pending = value
      clearTimeout(timer)
      timer = setTimeout(() => { void flush().catch(() => undefined) }, 200)
    },
    /** Wait for pending writes, keeping a failed snapshot available for retry. */
    flush,
  }
}
