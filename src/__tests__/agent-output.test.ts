import { describe, expect, it } from "vitest"
import { extractJsonObject } from "@/lib/agent-output"

describe("extractJsonObject", () => {
  it("parses valid structured JSON", () => {
    const result = extractJsonObject(
      JSON.stringify({
        mode: "approval",
        action: "summary",
        target: "com.example.test",
        summary: "Job is loaded.",
        risks: ["No stdout path"],
        recommended_next_step: "Inspect logs",
        approval_required: false,
        command_proposal: null,
        verification: ["Refresh job list"],
      })
    )

    expect(result).toMatchObject({
      action: "summary",
      target: "com.example.test",
      summary: "Job is loaded.",
      command_proposal: null,
    })
  })

  it("parses fenced JSON responses", () => {
    const result = extractJsonObject(`Here is the result:
\`\`\`json
{"mode":"approval","action":"proposal","target":"com.example.test","command_proposal":"launchctl kickstart -k gui/501/com.example.test","approval_required":true}
\`\`\``)

    expect(result?.action).toBe("proposal")
    expect(result?.command_proposal).toContain("kickstart")
  })

  it("returns null for invalid JSON", () => {
    expect(extractJsonObject("{not-json")).toBeNull()
  })

  it("fills missing optional fields with safe defaults", () => {
    const result = extractJsonObject(
      `{"mode":"approval","action":"remediation","target":"com.example.test"}`
    )

    expect(result).toMatchObject({
      summary: "",
      risks: [],
      recommended_next_step: "",
      approval_required: false,
      command_proposal: null,
      verification: [],
    })
  })

  it("normalizes blank command proposals to null", () => {
    const result = extractJsonObject(
      `{"mode":"approval","action":"proposal","target":"com.example.test","command_proposal":"   "}`
    )

    expect(result?.command_proposal).toBeNull()
  })
})
