import type { CalendarInterval } from "@/types"

/** Reject values outside launchd.plist calendar and positive interval integer domains. */
export function validateSchedule(interval: number | null, calendars: CalendarInterval[] | null): void {
  if (interval !== null && (!Number.isSafeInteger(interval) || interval < 1)) throw new Error("Interval must be a positive whole number of seconds.")
  for (const calendar of calendars ?? []) {
    for (const [key, low, high] of [["minute", 0, 59], ["hour", 0, 23], ["day", 1, 31], ["weekday", 0, 7], ["month", 1, 12]] as const) {
      const value = calendar[key]
      if (value !== null && value !== undefined && (!Number.isInteger(value) || value < low || value > high)) throw new Error(`${key} must be a whole number between ${low} and ${high}.`)
    }
  }
}

/** Require a finite ordered range of whole hours before expanding a schedule. */
export function validateHourRange(from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to > 23 || from > to) throw new Error("Hour range must use ordered whole hours from 0 to 23.")
}
