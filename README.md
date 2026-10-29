# Daemonic

A tray-first macOS GUI for inspecting and controlling `launchd` jobs. Built with Tauri v2, React, TypeScript, and Rust.

Daemonic — Master Your macOS Services. Daemonic focuses on fast menu bar access, safe user-agent control, and local agent assistance. The embedded assistant can summarize jobs, propose fixes, and draft launchctl actions, but model output is never executed as shell text.

![screenshot](screenshot.jpg)

## Features

- Menu bar app with tray actions for show, hide, refresh, and quit
- List User Agents (`~/Library/LaunchAgents/`), System Agents, and System Daemons
- Search by label and filter by source (User / System / Daemon)
- Start / Stop / Restart / Kickstart / Enable / Disable for User Agents
- Create new agents, edit and delete existing ones
- Schedule configuration (interval / calendar) with next run time preview
- View stdout / stderr logs
- Inspect plist configuration details
- Reveal plist file in Finder
- Local model routing through Ollama, llama.cpp/yama.cpp-compatible CLIs, or a custom local CLI
- Approval timeline for model-proposed launchctl actions
- Runtime readiness checks and a smoke test before using job context
- Proactive local job insights before prompting
- In-session assistant conversation history
- Semi-autonomous mode for safe user-agent start/kickstart proposals
- Service grouping, tags, and log-health visibility for local infrastructure
- Sidecar metadata fallback for services that cannot be tagged directly in the plist
- Per-service health checks, port visibility, and group-level bulk actions
- Common service templates plus a local Docker/OrbStack migration assistant
- Deterministic repair diagnostics with log excerpts and safe metadata fixes

System Agents and Daemons are read-only. Modification operations are limited to User Agents under `~/Library/LaunchAgents`.

## Service Groups And Tags

Daemonic stores optional app metadata inside each plist under a namespaced `LaunchControl` dictionary. `launchd` ignores these keys, while this app uses them to group related services such as `CAISS System`.

```xml
<key>LaunchControl</key>
<dict>
  <key>Group</key>
  <string>CAISS System</string>
  <key>Tags</key>
  <array>
    <string>caiss</string>
    <string>api</string>
    <string>local-infra</string>
  </array>
  <key>ManagedBy</key>
  <string>Daemonic</string>
  <key>Description</key>
  <string>CAISS API service</string>
  <key>Environment</key>
  <string>local</string>
</dict>
```

The main dashboard summarizes each group by service count, running count, jobs needing attention, and log coverage. The job table also exposes group, tags, health, and configured stdout/stderr paths so local launchd services stay visible after moving away from Docker or OrbStack.

When a plist cannot be modified directly, Daemonic also keeps a durable sidecar index in `~/Library/Application Support/Daemonic/service-overrides.json`. That index stores the same grouping and visibility metadata, including:

- `Group`
- `Tags`
- `ManagedBy`
- `Description`
- `Environment`
- `HealthCheckURL`
- `HealthCheckCommand`
- `Ports`
- `Template`
- `MigrationHint`
- `HealthStatus`
- `HealthDetail`
- `LastHealthCheckAt`

An explicitly configured URL is authoritative; inferred fallback endpoints cannot replace its failed result. The job detail pane can run the configured health check URL and persist the latest result back into that sidecar index. Command-based health checks (`HealthCheckCommand`) are disabled and report `unknown` when no health check URL is configured; stored command text is never executed. Bulk group actions are available from the dashboard cards for user agents only.

If a service has no explicit health URL or command, Daemonic falls back to lightweight local heuristics based on configured ports and a few common service labels. When nothing is configured it reports `unknown` instead of failing hard, so the user still gets a status readout.

## Agent Workflow

The agent panel is local-first and approval-gated:

- `Summarize`: explains the selected job and current state.
- `Plan fix`: proposes a remediation plan without applying changes.
- `Propose command`: asks the local model for a structured launchctl proposal.
- `Approval gate`: requires explicit user confirmation.
- `Apply action`: converts supported proposals into deterministic Rust commands.
- `Verification`: refreshes the job detail and shows the post-apply state.

Supported approved actions are classified into known operations only: start, stop, restart, kickstart, enable, and disable. Ambiguous or unsupported model proposals are rejected.

## Runtime Providers

Configure the local assistant from the agent panel:

- `Ollama`: runs `ollama run <model>`.
- `llama.cpp / yama.cpp`: runs a local executable with model and prompt flags.
- `Custom local CLI`: supports stdin or prompt-argument mode.

Quick start:

1. Pick a provider and fill in the required local executable/model fields.
2. Click `Save Runtime`.
3. Click `Smoke Test Runtime` and confirm it returns a short success response.
4. Choose `Summarize`, `Plan fix`, or `Propose command`, then click `Run Prompt`.
5. Use the `LLM draft` or `Migration assistant` panels in `New Agent` to prefill a LaunchAgent from a natural-language request or a Docker/OrbStack service definition.
6. In a job’s `Health` panel, click `Repair` to open the editor with inferred health check URL or command defaults when the service type is recognizable.
7. A successful probe is displayed as healthy only for a running service and for five minutes after the check. A fresh successful probe for a currently running service can supersede its historical exit status; historical startup text cannot.
8. Timestamp-free stderr does not erase independent failure evidence. Diagnostic and viewer tails read at most 256 KiB and 2,000 lines, including files with very long lines.
9. When a job has no explicit health check configured and no concrete repair suggestion, the Health panel stays informational and hides the `Repair` button.
10. Hover any code or log block to reveal a copy button. Press `Cmd/Ctrl+A` while the block is focused to select all text inside it, then click copy to capture the selected text or the raw block. Click a job label or file path label to copy it directly.
11. `New Agent` always starts a blank draft, even if you were editing a different plist before. Calendar schedule edits are preserved in the durable draft state until you save or cancel.
12. In the `Schedule` section, use the `Calendar agent` presets for common clock-based jobs: `Daily 9:00`, `Monday 9:00`, or `Every hour`.

The control surface shows readiness checks for executable, model, host, and prompt mode. Prompt execution stays disabled until the selected provider is complete. This is a local tool runner, not a remote chat API.

## Durable state and recovery

Preference changes are coalesced and saved in order, then flushed before window close or application quit. A failed save stays pending and is shown with a retry control. If the saved preferences cannot be loaded, autosave pauses to preserve the file; reloading requires confirmation before replacing in-memory edits. Window restoration fits the current display work areas.

App state uses owned, nonlinked regular files, private directory/file permissions (0700/0600), a cross-process writer lock, and synced atomic replacement. A plist change and its metadata snapshot use a private recovery journal. Failure rolls both back; startup recovers interrupted transactions. A conflicting external edit is preserved and blocks recovery for operator review. Atomic replacement checks the displaced inode and rolls back competing replacements; unresolved competing entries are retained under private `.daemonic-*.tmp` names for operator review. This recovers files and metadata; a service stopped before a failed deletion can remain stopped. New complete metadata snapshots honor explicit empty lists and cleared fields; legacy partial snapshots retain inheritance behavior.

Draft autosave deliberately omits command arguments, environment values, and raw plist text. Restored drafts display a warning and cannot be saved while fields are omitted; reload the original job or start a new draft. Existing app preferences are sanitized when loaded; older files under the legacy `launchd-ui` directory are retained and may still contain historical sensitive data. Do not put credentials in service descriptions or other ordinary metadata.

New log destinations require an existing owned directory without writable shared parents or symlinks. On an authorized app launch, Daemonic prepares `~/Library/Logs/Daemonic` with private permissions. Existing jobs using shared log directories must be reviewed before saving. Calendar fields are checked against launchd ranges; Day and Weekday match either condition when both are supplied. Model drafts undergo the same checks and cannot silently drop migration schedule, environment, or port fields.

## Assistant Modes

The assistant keeps an in-session history of recent local model turns, including prompt, response, structured summary, and command proposal status. It also surfaces proactive local signals, such as read-only system ownership, non-zero exit codes, disabled jobs, KeepAlive mismatch, and stderr paths.

Semi-autonomous mode is deliberately conservative. When enabled, only safe user-agent start or kickstart-style proposals can auto-apply. Stop, restart, bootout, disable, ambiguous proposals, and system-owned jobs remain locked behind manual review.

## Safety Notes

- Arbitrary model-generated shell commands are never executed.
- Health URLs must use HTTP(S) and loopback IPs or `localhost` (pinned to loopback). Native HTTP probes bypass proxies, reject redirects and URL credentials, share a five-second check budget, and read at most 64 KiB. Response bodies are never persisted.
- System agents and daemons stay read-only in the UI and backend. Health observations are saved only in the app-owned overlay, never in system plists.
- User-agent mutations require a `~/Library/LaunchAgents/*.plist` path.
- Mutation targets must be regular owned files directly inside that directory, with matching filename, plist label, and request label. Traversal, symbolic links, and hardlinks are rejected. New labels use letters, digits, dots, underscores, and hyphens; creation cannot overwrite a file. Log directories must already exist and have no symlink components; the standard root-owned macOS `/tmp` and `/var` aliases are accepted.
- Log clearing requires a validated user-agent plist declaring that exact log path; system-job logs are read-only. The backend independently restricts automatic actions to start/kickstart.
- Semi-autonomous execution is opt-in and limited to safe user-agent start/kickstart proposals.
- Enable, disable, and kickstart use the current `gui/<uid>/<label>` target. Start bootstraps an unloaded plist, kickstarts a loaded idle job without killing it, and leaves a running job alone. Stop and restart boot out the validated plist path.
- File writes retain the validated inode through directory/file descriptors; launchctl pathname operations recheck file identity immediately before execution.
- Approved actions return the exact display command plus verified post-action status.
- The audit trail retains prompt, job context, structured result, raw response, and runtime command line.

## Install

Packaging qualification is pending in Redmine #4491. The current legacy installer and DMG scripts are not qualified for use. Do not install or launch this build until the user separately authorizes it through the project orchestrator. Source-build instructions below create an uninstalled bundle; they do not perform runtime acceptance. The quarantined historical app must remain unlaunched.

## macOS Antivirus Notes

- The Rust build output under `src-tauri/target/` is disposable compiler output.
- If your antivirus or endpoint protection flags a file there, exclude `src-tauri/target/` rather than the shipped `.app` bundle.
- The release bundle is the artifact to inspect and distribute: `src-tauri/target/release/bundle/macos/Daemonic.app`.

## Tech Stack

- Tauri v2 (Rust backend) + React + TypeScript + Vite
- UI: Tailwind CSS v4 + shadcn/ui
- Lint: oxlint (TypeScript), cargo clippy + rustfmt (Rust)
- Test: vitest (Frontend), cargo test (Rust)
- Package manager: pnpm

## Development

```bash
# Install dependencies
pnpm install

# Dev mode (launches app with hot reload)
pnpm tauri:dev

# Frontend only
pnpm dev

# Production build plus install to /Applications
pnpm package:macos:install

# Production DMG
pnpm tauri:build
```

## Compile And Run

For a local build and manual launch:

```bash
cd /Users/jeffreycruz/Development/TOOLS/daemonic
pnpm install
pnpm tauri:build
open /Applications/Daemonic.app
```

If macOS blocks the unsigned app, remove quarantine first:

```bash
xattr -cr /Applications/Daemonic.app
```

## Testing / Lint

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
pnpm test:release
pnpm version:check

RUSTUP_HOME=$HOME/.rustup cargo test --manifest-path src-tauri/Cargo.toml
RUSTUP_HOME=$HOME/.rustup cargo fmt --manifest-path src-tauri/Cargo.toml --check
RUSTUP_HOME=$HOME/.rustup cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## License

MIT


## Upstream integration and qualification

The integration branch for Redmine #4490 includes upstream `d0ea653` (eight commits through release 1.4.2 and the Rust security-dependency update). Daemonic retains its application identity, tray interface, bounded health probes, validated mutations and recoverable state. Home is a presentation heuristic for user-authored scripts under the home directory; it grants no mutation permission. Run now uses the existing validated backend. Commands are copied for manual inspection and are never executed by the command panel. Theme selection follows the system unless light/dark is selected.

`pnpm version:check` requires matching package, Tauri, Cargo manifest and root lock versions. Version bump scripts stage these four files and roll back caught replacement failures, without committing, tagging or publishing. Abrupt interruption can leave private `.previous` recovery snapshots: restore a consistent set from Git or the snapshots and rerun `pnpm version:check` before continuing. Release-script tests run separately with `pnpm test:release`. The current source qualification is separate from installation and runtime acceptance; see `ROADMAP.md` and `docs/qualification/m3-upstream-4490.md`.

### Historical DB2 examples

`src-tauri/src/db2_missing_index_examples.json` is retained byte-for-byte as historical user material. It is unrelated to Daemonic's launchd features, is not loaded by the app, and is not configured as a bundled resource. Its performance claims are unvalidated; six examples reference undefined SQL and nine index names collide. Do not execute the examples or use them as a qualified training/benchmark corpus. This milestone preserves the file in place rather than moving or deleting it. See `docs/qualification/db2-scope.md`.
