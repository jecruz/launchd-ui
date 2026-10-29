import { afterEach, expect, it, vi } from "vitest"
import { createPreferenceWriter } from "./preference-writer"

afterEach(() => vi.useRealTimers())

it("coalesces changes and waits for in-flight saves before writing the latest snapshot", async () => {
  vi.useFakeTimers()
  let finish!: () => void
  const pending = new Promise<void>((resolve) => { finish = resolve })
  const save = vi.fn().mockImplementationOnce(() => pending).mockResolvedValue(undefined)
  const writer = createPreferenceWriter<number>(save, vi.fn())
  writer.schedule(1)
  writer.schedule(2)
  await vi.advanceTimersByTimeAsync(200)
  expect(save.mock.calls).toEqual([[2]])
  writer.schedule(3)
  writer.schedule(4)
  await vi.advanceTimersByTimeAsync(200)
  expect(save).toHaveBeenCalledTimes(1)
  finish()
  await writer.flush()
  expect(save.mock.calls).toEqual([[2], [4]])
})

it("reports a save failure and retains the snapshot for an explicit retry", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("disk full")).mockResolvedValue(undefined)
  const report = vi.fn()
  const writer = createPreferenceWriter<number>(save, report)
  writer.schedule(7)
  await expect(writer.flush()).rejects.toThrow("disk full")
  expect(report).toHaveBeenCalledWith(expect.stringContaining("disk full"))
  await writer.flush()
  expect(save.mock.calls).toEqual([[7], [7]])
  expect(report).toHaveBeenLastCalledWith(null)
})
