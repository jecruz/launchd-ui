# FUBAR Research: Daemonic

## Repo Shape

- App: Tauri v2 desktop app for macOS launchd management.
- Frontend: React 19, TypeScript, Vite, Tailwind CSS v4, shadcn-style UI primitives.
- Backend: Rust Tauri commands wrapping launchctl, plist parsing, log file helpers, and local agent runtime adapters.
- Package manager: `pnpm`.
- Verification tools: `pnpm typecheck`, `pnpm build`, `pnpm test`, `pnpm lint`, `cargo test`, `cargo fmt --check`, `cargo clippy`.

## Current Changed Surface

- `src/App.tsx`: tray-first app shell, mode cards, selected job focus panel, agent panel integration.
- `src/components/AgentPanel.tsx`: local runtime configuration, job-aware prompts, structured output parsing, approval timeline, audit trail.
- `src-tauri/src/agent_runtime.rs`: local runtime settings and provider execution for llama.cpp/yama.cpp, Ollama, and custom local CLI.
- `src-tauri/src/commands.rs`: Tauri commands for runtime settings, prompt execution, and approved action execution.
- `src-tauri/src/lib.rs`: menu bar/tray setup and command registration.
- `src/lib/invoke.ts` and `src/types.ts`: typed frontend/backend contracts.
- `src/test-utils/tauri-mock.ts`: fake Tauri IPC support for frontend tests.

## Existing Safety Pattern

- Direct launchd mutations are guarded by `ensure_user_agent`.
- `apply_approved_agent_action` classifies model command proposals into known action kinds.
- Execution routes through internal helpers, not arbitrary shell text.
- System agents and system daemons remain read-only in UI copy and backend mutation path.

## Existing Agent Workflow

- Runtime providers:
  - `LlamaCpp`
  - `Ollama`
  - `LocalCli`
- Agent actions:
  - `summary`
  - `remediation`
  - `proposal`
- Structured output parser expects JSON keys:
  - `mode`
  - `action`
  - `target`
  - `summary`
  - `risks`
  - `recommended_next_step`
  - `approval_required`
  - `command_proposal`
  - `verification`
- Timeline stages:
  - Summary
  - Preview
  - Approval gate
  - Apply action
  - Verification
- Audit trail preserves raw prompt, context, command line, structured result, applied action, and model response.

## Risks Found

- Command classification is string-based and may misclassify ambiguous model proposals.
- `enable_job` and `disable_job` expose backend commands without plist-path user-agent validation.
- Frontend structured parser and timeline behavior do not yet have direct tests.
- Agent runtime execution has Rust tests for defaults, quote parsing, and template rendering, but no frontend workflow tests.
- README still describes the upstream app more than the new tray-first agent-driven direction.

## Useful Existing Tests

- Frontend:
  - `src/hooks/useJobs.test.ts`
  - `src/components/JobList.test.tsx`
  - `src/__tests__/calendar-utils.test.ts`
- Backend:
  - launchctl list parsing tests
  - plist parsing and writing tests
  - agent runtime settings/template tests

## Recommended Verification Baseline

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
RUSTUP_HOME=$HOME/.rustup cargo test --manifest-path src-tauri/Cargo.toml
RUSTUP_HOME=$HOME/.rustup cargo fmt --manifest-path src-tauri/Cargo.toml --check
RUSTUP_HOME=$HOME/.rustup cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```
