# Launch Control

A tray-first macOS GUI for inspecting and controlling `launchd` jobs. Built with Tauri v2, React, TypeScript, and Rust.

Launch Control focuses on fast menu bar access, safe user-agent control, and local agent assistance. The embedded assistant can summarize jobs, propose fixes, and draft launchctl actions, but model output is never executed as shell text.

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

System Agents and Daemons are read-only. Modification operations are limited to User Agents under `~/Library/LaunchAgents`.

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

The control surface shows readiness checks for executable, model, host, and prompt mode. Prompt execution stays disabled until the selected provider is complete. Use `Smoke Test Runtime` to verify the local runtime before sending job context.

## Safety Notes

- Arbitrary model-generated shell commands are never executed.
- System agents and daemons stay read-only in the UI and backend.
- User-agent mutations require a `~/Library/LaunchAgents/*.plist` path.
- Enable and disable use `launchctl bootstrap` and `launchctl bootout` with the actual plist path.
- Start, stop, restart, and kickstart use the current `gui/<uid>/<label>` target.
- Approved actions return the exact display command plus verified post-action status.
- The audit trail retains prompt, job context, structured result, raw response, and runtime command line.

## Install

This app is not code-signed. Download and install via CLI:

```bash
# Download and extract (Apple Silicon)
curl -L "https://github.com/azu/launchd-ui/releases/latest/download/launchd-ui_aarch64.app.tar.gz" | tar xz -C /Applications
# Remove quarantine attribute (required for unsigned apps)
xattr -cr /Applications/launchd-ui.app
```

For Intel Macs, replace `aarch64` with `x64`.

DMG installers are also available on the [Releases](https://github.com/azu/launchd-ui/releases) page.

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

# Production build (DMG)
pnpm tauri:build
```

## Testing / Lint

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint

RUSTUP_HOME=$HOME/.rustup cargo test --manifest-path src-tauri/Cargo.toml
RUSTUP_HOME=$HOME/.rustup cargo fmt --manifest-path src-tauri/Cargo.toml --check
RUSTUP_HOME=$HOME/.rustup cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

## License

MIT
