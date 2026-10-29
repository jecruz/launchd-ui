import { act, renderHook } from "@testing-library/react"
import { afterEach, expect, it } from "vitest"
import { resetFakeHandlers, setFakeHandler } from "@/test-utils/tauri-mock"
import { useLogs } from "./useLogs"

afterEach(resetFakeHandlers)

it("keeps a newer log and rejects invalid timestamps when the previous request finishes late", async () => {
  let resolveOld!: (value: unknown) => void
  setFakeHandler("read_log_file", ({ path }) => path === "old" ? new Promise((resolve) => { resolveOld = resolve }) : { content: "new", modified_at: "99999999999999999999" })
  const { result } = renderHook(useLogs)
  let old!: Promise<void>
  act(() => { old = result.current.fetchLog("old", "owner.plist") })
  await act(() => result.current.fetchLog("new", "owner.plist"))
  await act(async () => { resolveOld({ content: "old", modified_at: "1" }); await old })
  expect(result.current.content).toBe("new")
  expect(result.current.modifiedAt).toBeNull()
  expect(result.current.error).toBeNull()
})
