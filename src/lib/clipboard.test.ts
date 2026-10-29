import { afterEach, expect, it, vi } from "vitest"
import { copyTextToClipboard } from "./clipboard"

afterEach(() => { vi.restoreAllMocks() })

it("falls back after a denied Clipboard API request and removes its temporary textarea", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("Denied")) } })
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn().mockImplementation(() => {
    expect(document.querySelector("textarea")?.value).toBe("actual text")
    return true
  }) })
  await copyTextToClipboard("actual text")
  expect(document.querySelector("textarea")).toBeNull()
  vi.mocked(document.execCommand).mockImplementation(() => { throw new Error("Denied") })
  await expect(copyTextToClipboard("again")).rejects.toThrow("Denied")
  expect(document.querySelector("textarea")).toBeNull()
})
