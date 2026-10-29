import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import App from "./App"
import { resetFakeHandlers, setFakeHandler } from "@/test-utils/tauri-mock"

const native = vi.hoisted(() => ({
  close: undefined as undefined | ((event: { preventDefault: () => void }) => Promise<void>),
  hide: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@tauri-apps/api/app", () => ({ show: vi.fn().mockResolvedValue(undefined), hide: vi.fn().mockResolvedValue(undefined), setDockVisibility: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }))
vi.mock("@tauri-apps/api/window", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/window")>(),
  availableMonitors: vi.fn().mockResolvedValue([]),
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: typeof native.close) => { native.close = handler; return () => undefined },
    onMoved: vi.fn().mockResolvedValue(() => undefined), onResized: vi.fn().mockResolvedValue(() => undefined),
    center: vi.fn().mockResolvedValue(undefined), hide: native.hide,
    show: vi.fn().mockResolvedValue(undefined), unminimize: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn().mockResolvedValue(undefined),
  }),
}))

afterEach(() => { resetFakeHandlers(); vi.restoreAllMocks(); native.hide.mockClear() })

it("continues a bulk group action after one failure and refreshes partial results", async () => {
  const action = vi.fn(({ plistPath }) => { if (String(plistPath).includes("running-agent")) throw new Error("Rejected first action") })
  setFakeHandler("kickstart_job", action)
  vi.spyOn(window, "confirm").mockReturnValue(true)
  const view = render(<App />)
  const card = (await screen.findAllByText("CAISS System")).map((element) => element.closest('[role="button"]')).find(Boolean) as HTMLElement
  await userEvent.setup().click(within(card).getByRole("button", { name: "Test all" }))
  await screen.findByText(/1 of 2 actions failed/)
  expect(action).toHaveBeenCalledTimes(2)
  expect(action.mock.calls[1][0].plistPath).toContain("stopped-agent")
  view.unmount()
})

it("keeps the window visible when preference flush fails and allows a retry", async () => {
  const save = vi.fn().mockRejectedValueOnce(new Error("Disk unavailable")).mockResolvedValue(undefined)
  setFakeHandler("save_app_preferences", save)
  const view = render(<App />)
  await screen.findByDisplayValue("running")
  await waitFor(() => expect(native.close).toBeDefined())
  await act(async () => native.close?.({ preventDefault: vi.fn() }))
  expect(native.hide).not.toHaveBeenCalled()
  expect(screen.getByText(/Preferences could not be saved/)).toBeInTheDocument()
  await act(async () => native.close?.({ preventDefault: vi.fn() }))
  expect(native.hide).toHaveBeenCalledTimes(1)
  view.unmount()
})
