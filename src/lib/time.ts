const twentyFourHourFormatter = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
})

/**
 * Format an epoch millisecond timestamp using 24-hour time.
 */
export function formatEpochMillis24(epochMillis: string | number): string {
  const value = typeof epochMillis === "string" ? Number(epochMillis) : epochMillis
  if (!Number.isFinite(value)) return "—"
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return "—"
  return twentyFourHourFormatter.format(date)
}
