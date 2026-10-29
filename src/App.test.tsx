import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, expect, it, vi } from "vitest"
import App from "./App"
import { getJobDetail } from "@/lib/invoke"
import { resetFakeHandlers, setFakeHandler } from "@/test-utils/tauri-mock"

const native = vi.hoisted(() => ({
  close: undefined as undefined | ((event: { preventDefault: () => void }) => Promise<void>),
  hide: vi.fn().mockResolvedValue(undefined),
  size: vi.fn().mockResolvedValue(undefined), position: vi.fn().mockResolvedValue(undefined),
  moved: vi.fn().mockResolvedValue(() => undefined), resized: vi.fn().mockResolvedValue(() => undefined),
  show: vi.fn().mockResolvedValue(undefined), monitors: vi.fn().mockResolvedValue([]),
}))
vi.mock("@tauri-apps/api/app", () => ({ show: vi.fn().mockResolvedValue(undefined), hide: vi.fn().mockResolvedValue(undefined), setDockVisibility: vi.fn().mockResolvedValue(undefined) }))
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => undefined) }))
vi.mock("@tauri-apps/api/window", async (original) => ({
  ...await original<typeof import("@tauri-apps/api/window")>(),
  availableMonitors: native.monitors,
  getCurrentWindow: () => ({
    onCloseRequested: async (handler: typeof native.close) => { native.close = handler; return () => undefined },
    onMoved: native.moved, onResized: native.resized, setSize: native.size, setPosition: native.position,
    center: vi.fn().mockResolvedValue(undefined), hide: native.hide,
    show: native.show, unminimize: vi.fn().mockResolvedValue(undefined), setFocus: vi.fn().mockResolvedValue(undefined),
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

it.each(["size", "position"] as const)("keeps tracking and showing the window when %s restoration fails", async (operation) => {
  native.monitors.mockResolvedValueOnce([{ workArea: { position: { x: 0, y: 0 }, size: { width: 1920, height: 1080 } } }])
  native[operation].mockRejectedValueOnce(new Error("Rejected geometry"))
  const movedBefore = native.moved.mock.calls.length
  const showBefore = native.show.mock.calls.length
  const view = render(<App />)
  await screen.findByText(/restoration failed/)
  await waitFor(() => expect(native.moved.mock.calls.length).toBeGreaterThan(movedBefore))
  await waitFor(() => expect(native.show.mock.calls.length).toBeGreaterThan(showBefore))
  view.unmount()
})

it("opening a new draft invalidates a delayed list edit", async () => {
  const old = await getJobDetail("/Users/test/Library/LaunchAgents/com.example.running-agent.plist")
  let finish!: (value: typeof old) => void
  setFakeHandler("get_job_detail", () => new Promise((resolve) => { finish = resolve }))
  const view = render(<App />)
  const row = (await screen.findByText("com.example.running-agent")).closest("tr") as HTMLElement
  await userEvent.setup().click(within(row).getByTitle("Edit"))
  await userEvent.setup().click(screen.getByRole("button", { name: "New Agent" }))
  await act(async () => finish(old))
  expect(screen.getByRole("heading", { name: "New Agent" })).toBeInTheDocument()
  expect(screen.getByLabelText(/^Label/)).toHaveValue("")
  view.unmount()
})

it("keeps preference-backed controls unavailable until a deferred bootstrap completes", async () => {
  let finish!: (value: unknown) => void
  setFakeHandler("get_app_preferences", () => new Promise((resolve) => { finish = resolve }))
  const view = render(<App />)
  expect(screen.getByRole("status")).toHaveTextContent("Loading saved preferences")
  expect(screen.queryByRole("button", { name: "New Agent" })).not.toBeInTheDocument()
  await act(async () => finish({ search: "loaded", source_filter: "All", group_filter: "All", sort_key: "label", sort_direction: "asc", agent_mode: "approval", detail_open: false, form_open: false, selected_plist_path: null, job_form_draft: null, window_geometry: null }))
  expect(await screen.findByDisplayValue("loaded")).toBeInTheDocument()
  view.unmount()
})
