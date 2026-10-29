import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { copyTextToClipboard } from "@/lib/clipboard"

function getSelectedTextWithin(node: HTMLElement | null): string | null {
  if (!node) return null

  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0) return null

  const range = selection.getRangeAt(0)
  if (!node.contains(range.commonAncestorContainer)) return null

  const text = selection.toString()
  return text.trim().length > 0 ? text : null
}

function selectAllWithin(node: HTMLElement | null) {
  if (!node) return

  const selection = window.getSelection()
  if (!selection) return

  const range = document.createRange()
  range.selectNodeContents(node)
  selection.removeAllRanges()
  selection.addRange(range)
}

type CopyButtonProps = {
  onCopy: () => Promise<void>
  copied: boolean
  ariaLabel: string
}

function CopyButton({ onCopy, copied, ariaLabel }: CopyButtonProps) {
  return (
    <Button
      type="button"
      variant="secondary"
      size="icon"
      className={cn(
        "absolute right-2 top-2 h-7 w-7 border border-white/10 bg-background/90 text-muted-foreground shadow-sm backdrop-blur transition",
        "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
      )}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => void onCopy()}
      aria-label={ariaLabel}
      title={ariaLabel}
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </Button>
  )
}

type CopyableCodeBlockProps = {
  children: ReactNode
  text: string
  className?: string
  copyLabel?: string
}

/**
 * Render a hover-copy overlay for a block of text.
 */
export function CopyableCodeBlock({
  children,
  text,
  className,
  copyLabel = "Copy block text",
}: CopyableCodeBlockProps) {
  const contentRef = useRef<HTMLDivElement | null>(null)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timeout)
  }, [copied])

  const handleCopy = async () => {
    const selectionText = getSelectedTextWithin(contentRef.current)
    await copyTextToClipboard(selectionText ?? text)
    setCopied(true)
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
      event.preventDefault()
      selectAllWithin(contentRef.current)
    }
  }

  return (
    <div
      className={cn("group relative rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring", className)}
      tabIndex={0}
      onKeyDown={handleKeyDown}
    >
      <div ref={contentRef}>{children}</div>
      <CopyButton onCopy={handleCopy} copied={copied} ariaLabel={copyLabel} />
    </div>
  )
}

type CopyableInlineTextProps = {
  text: string
  className?: string
  copyLabel?: string
}

/**
 * Render inline text that copies on click and flips to a checkmark after success.
 */
export function CopyableInlineText({
  text,
  className,
  copyLabel = "Copy text",
}: CopyableInlineTextProps) {
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    if (!copied) return
    const timeout = window.setTimeout(() => setCopied(false), 1200)
    return () => window.clearTimeout(timeout)
  }, [copied])

  const handleCopy = async () => {
    await copyTextToClipboard(text)
    setCopied(true)
  }

  return (
    <button
      type="button"
      onClick={() => void handleCopy()}
      onMouseDown={(event) => event.preventDefault()}
      className={cn(
        "group inline-flex min-w-0 items-center gap-1 rounded px-1 py-0.5 text-left transition hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      )}
      aria-label={copyLabel}
      title={copyLabel}
    >
      <span className="min-w-0 truncate">{text}</span>
      {copied ? <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" /> : <Copy className="h-3.5 w-3.5 shrink-0 opacity-0 transition group-hover:opacity-100" />}
    </button>
  )
}
