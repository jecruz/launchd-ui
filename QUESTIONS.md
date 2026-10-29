# FUBAR Questions: Daemonic

## Task

Run the FUBAR workflow for `Daemonic`, focused on stabilizing the current agent-driven macOS menu bar launchd control surface.

## User

- Primary user: macOS power user or developer managing `launchd` user agents from a desktop GUI.
- Secondary user: operator who wants local AI assistance for diagnosis, remediation planning, and safe launchctl action proposals.

## Done Means

- The current tray-first `Daemonic` app has a documented implementation roadmap.
- Agent-assisted behavior is bounded by deterministic backend execution and explicit approval gates.
- User-agent mutations remain allowed only for `~/Library/LaunchAgents`.
- System agents and daemons remain read-only.
- Local model adapters remain configurable and do not ship job context off-machine unless the configured local runtime does so.
- Verification commands pass before any build task is considered complete.

## Hard Constraints

- Preserve the existing Tauri v2 + React + TypeScript + Rust architecture.
- Keep modifications scoped to `Daemonic`.
- Follow existing repo conventions in `CLAUDE.md`.
- Use `RUSTUP_HOME=$HOME/.rustup` for cargo commands in this environment.
- Use `pnpm`, not npm or yarn.
- Do not make arbitrary shell execution possible from model output.
- Do not allow system launch agents or daemons to be mutated through the agent path.
- Use deterministic launchctl helper functions for mutations.
- Keep raw agent/runtime details available for audit, but make the primary UI operational and compact.

## Explicitly Out Of Scope

- Code signing, notarization, or App Store packaging.
- Privileged helper installation for system daemon mutation.
- Cloud-hosted model integration.
- Autonomous execution against system launch domains.
- Replacing Tauri with a native Swift app.
- Broad redesign of existing job list, job detail, plist editor, or log viewer unless required by the agent workflow.

## Open Questions

- Should FUBAR continue in default mode, quick mode, or strict mode?
- Should the next build milestone prioritize backend safety tests, frontend workflow tests, or visual polish?
- Should Redmine issues 422-426 be updated as part of this workflow, or should FUBAR stay repo-local?
- Is a final commit desired after the first approved build task?

## Issue References

- Redmine project memory from the session indicates `Daemonic` project id `56`.
- Existing related Redmine issue ids: `422`, `423`, `424`, `425`, `426`.
