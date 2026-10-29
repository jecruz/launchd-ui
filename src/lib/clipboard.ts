/**
 * Copy text to the system clipboard with a browser API first and a textarea fallback.
 */
export async function copyTextToClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(text); return } catch { /* WebView permission failures use the fallback below. */ }
  }

  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.setAttribute("readonly", "true")
  textarea.style.position = "fixed"
  textarea.style.left = "-9999px"
  textarea.style.top = "0"
  document.body.appendChild(textarea)
  textarea.select()

  let succeeded = false
  try { succeeded = document.execCommand("copy") } finally { textarea.remove() }

  if (!succeeded) {
    throw new Error("Failed to copy text to the clipboard.")
  }
}
