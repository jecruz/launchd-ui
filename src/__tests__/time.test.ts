import { describe, expect, it } from "vitest"
import { formatEpochMillis24 } from "@/lib/time"

describe("formatEpochMillis24", () => {
  it("formats timestamps with 24-hour time", () => {
    const result = formatEpochMillis24("1710000000000")

    expect(result).toMatch(/\b\d{1,2}\/\d{1,2}\/\d{4}, \d{2}:\d{2}:\d{2}\b/)
  })

  it("returns a dash for invalid timestamps", () => {
    expect(formatEpochMillis24("not-a-number")).toBe("—")
    expect(formatEpochMillis24("999999999999999999999")).toBe("—")
  })
})
