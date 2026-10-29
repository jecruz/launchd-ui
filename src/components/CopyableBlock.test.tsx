import { afterEach, describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { CopyableCodeBlock, CopyableInlineText } from "./CopyableBlock"

function installClipboardMock() {
  const writeText = vi.fn().mockResolvedValue(undefined)
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText,
    },
  })
  return writeText
}

afterEach(() => {
  window.getSelection()?.removeAllRanges()
  vi.restoreAllMocks()
})

describe("CopyableBlock", () => {
  it("selects all block text with cmd or ctrl a", () => {
    render(
      <CopyableCodeBlock text="line one\nline two">
        <pre>line one{"\n"}line two</pre>
      </CopyableCodeBlock>
    )

    const pre = screen.getByText((_, element) => element?.tagName === "PRE")
    const wrapper = pre.closest('[tabindex="0"]') as HTMLDivElement
    wrapper.focus()

    fireEvent.keyDown(wrapper, { key: "a", metaKey: true })

    expect(window.getSelection()?.toString()).toContain("line one")
    expect(window.getSelection()?.toString()).toContain("line two")

    window.getSelection()?.removeAllRanges()
    fireEvent.keyDown(wrapper, { key: "a", ctrlKey: true })

    expect(window.getSelection()?.toString()).toContain("line one")
    expect(window.getSelection()?.toString()).toContain("line two")
  })

  it("copies the current selection when present inside the block", async () => {
    const user = userEvent.setup()
    const writeText = installClipboardMock()

    render(
      <CopyableCodeBlock text="raw block text" copyLabel="Copy log text">
        <pre>selected line one{"\n"}selected line two</pre>
      </CopyableCodeBlock>
    )

    const pre = screen.getByText((_, element) => element?.tagName === "PRE")
    const selection = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(pre)
    selection?.removeAllRanges()
    selection?.addRange(range)

    await user.click(screen.getByRole("button", { name: "Copy log text" }))

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("selected line one\nselected line two")
    })
  })

  it("copies the raw inline text and flips to a checkmark", async () => {
    const user = userEvent.setup()
    const writeText = installClipboardMock()

    render(<CopyableInlineText text="/Users/test/Library/Logs/Daemonic/service.log" copyLabel="Copy log path" />)

    const button = screen.getByRole("button", { name: "Copy log path" })
    expect(button).toHaveTextContent("/Users/test/Library/Logs/Daemonic/service.log")

    await user.click(button)

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("/Users/test/Library/Logs/Daemonic/service.log")
      expect(screen.getByRole("status")).toHaveTextContent("Copied")
    })
  })
})


it("shows clipboard failures for inline and block copying", async () => {
  const writeText = installClipboardMock()
  writeText.mockRejectedValue(new Error("denied"))
  Object.defineProperty(document, "execCommand", { configurable: true, value: vi.fn().mockReturnValue(false) })
  render(<><CopyableInlineText text="inline" /><CopyableCodeBlock text="block"><pre>block</pre></CopyableCodeBlock></>)
  fireEvent.click(screen.getByRole("button", { name: "Copy text" }))
  fireEvent.click(screen.getByRole("button", { name: "Copy block text" }))
  await waitFor(() => expect(screen.getAllByRole("alert")).toHaveLength(2))
  expect(screen.queryByRole("status")).not.toBeInTheDocument()
  expect(document.querySelector('textarea')).toBeNull()
})
