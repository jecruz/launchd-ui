import { useState, useEffect } from "react"
import { copyTextToClipboard } from "@/lib/clipboard"
import { Check, Copy } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { LaunchdJob } from "@/types"

type CommandPanelProps = {
  job: LaunchdJob
}

type CommandRow = {
  label: string
  command: string
  destructive?: boolean
}

/** Quote one literal shell argument for operator-copied commands. */
export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value
  return `'${value.replace(/'/g, "'\\''")}'`
}

function domainFor(job: LaunchdJob): string {
  if (job.source === "SystemDaemon") return "system"
  return "gui/$(id -u)"
}

/** Build display-only commands; this panel never executes them. */
export function buildCommands(job: LaunchdJob): CommandRow[] {
  if (job.source !== "UserAgent") {
    return [{ label: "Inspect", command: `launchctl print ${domainFor(job)}/${shellQuote(job.label)}` }]
  }
  const domain = domainFor(job)
  const target = `${domain}/${shellQuote(job.label)}`
  const plistPath = shellQuote(job.plist_path)

  return [
    { label: "Start", command: `launchctl bootstrap ${domain} ${plistPath}` },
    { label: "Stop", command: `launchctl bootout ${domain} ${plistPath}` },
    { label: "Kickstart", command: `launchctl kickstart -k ${target}` },
    { label: "Enable", command: `launchctl enable ${target}` },
    { label: "Disable", command: `launchctl disable ${target}` },
    {
      label: "Remove",
      command: `rm ${plistPath}`,
      destructive: true,
    },
  ]
}

/** Show inspectable launchctl commands with explicit clipboard feedback. */
export function CommandPanel({ job }: CommandPanelProps) {
  const [copied, setCopied] = useState<string | null>(null)
  const commands = buildCommands(job)
  const [copyError, setCopyError] = useState<string | null>(null)
  useEffect(() => {
    setCopied(null)
    setCopyError(null)
  }, [job.plist_path])
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(null), 1200)
    return () => window.clearTimeout(timer)
  }, [copied])

  const copyCommand = async (command: string) => {
    try {
      setCopyError(null)
      await copyTextToClipboard(command)
      setCopied(command)
    } catch (error) {
      setCopied(null)
      setCopyError(`Could not copy command: ${String(error)}`)
    }
  }

  return (
    <section className="space-y-2">
      <h4 className="text-sm font-medium">Commands</h4>
      <p className="text-xs text-muted-foreground">Copy for manual inspection. These commands are never executed by this panel.</p>
      {copyError && <p role="alert" className="text-sm text-destructive">{copyError}</p>}
      <div className="space-y-2">
        {commands.map((item) => (
          <div
            key={item.label}
            className="grid grid-cols-[5rem_minmax(0,1fr)] items-center gap-2"
          >
            <span
              className={
                item.destructive
                  ? "text-sm font-medium text-destructive"
                  : "text-sm text-muted-foreground"
              }
            >
              {item.label}
            </span>
            <div className="flex min-w-0 items-center gap-2 rounded-md bg-muted px-3 py-2">
              <code className="min-w-0 flex-1 truncate font-mono text-sm">
                {item.command}
              </code>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0"
                aria-label={`Copy ${item.label.toLowerCase()} command`}
                onClick={() => void copyCommand(item.command)}
              >
                {copied === item.command ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}
