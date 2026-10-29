import { expect, it } from "vitest"
import { validateSchedule, validateHourRange } from "./schedule-validation"

it.each([[-1, 0], [24, 24], [1.5, 3], [7, 2]])("rejects invalid hour range %s to %s", (from, to) => {
  expect(() => validateHourRange(from, to)).toThrow()
})

it.each([["minute", 99], ["hour", 2.5], ["day", 0], ["weekday", 9], ["month", 13]] as const)("rejects an invalid %s", (key, value) => {
  expect(() => validateSchedule(null, [{ minute: null, hour: null, day: null, weekday: null, month: null, [key]: value }])).toThrow()
})

it("accepts calendar boundary values and rejects zero or fractional interval seconds", () => {
  expect(() => validateSchedule(null, [{ minute: 59, hour: 23, day: 31, weekday: 7, month: 12 }])).not.toThrow()
  for (const value of [0, -1, 1.5, Infinity]) expect(() => validateSchedule(value, null)).toThrow()
})
