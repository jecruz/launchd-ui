export type AgentAction = "summary" | "remediation" | "proposal"

export type StructuredAgentResult = {
  mode: string
  action: AgentAction
  target: string
  summary: string
  risks: string[]
  recommended_next_step: string
  approval_required: boolean
  command_proposal: string | null
  verification: string[]
}

export function extractJsonObject(input: string): StructuredAgentResult | null {
  const fenced = input.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim()
  const candidate = fenced ?? input.trim()
  const start = candidate.indexOf("{")
  const end = candidate.lastIndexOf("}")
  if (start < 0 || end < 0 || end <= start) return null

  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as Partial<StructuredAgentResult>
    if (
      typeof parsed.mode === "string" &&
      (parsed.action === "summary" || parsed.action === "remediation" || parsed.action === "proposal") &&
      typeof parsed.target === "string"
    ) {
      return {
        mode: parsed.mode,
        action: parsed.action,
        target: parsed.target,
        summary: typeof parsed.summary === "string" ? parsed.summary : "",
        risks: Array.isArray(parsed.risks) ? parsed.risks.filter((item): item is string => typeof item === "string") : [],
        recommended_next_step:
          typeof parsed.recommended_next_step === "string" ? parsed.recommended_next_step : "",
        approval_required: Boolean(parsed.approval_required),
        command_proposal:
          typeof parsed.command_proposal === "string" && parsed.command_proposal.trim().length > 0
            ? parsed.command_proposal
            : null,
        verification: Array.isArray(parsed.verification)
          ? parsed.verification.filter((item): item is string => typeof item === "string")
          : [],
      }
    }
  } catch {
    return null
  }

  return null
}
