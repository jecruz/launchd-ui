# Daemonic — Constitution

> Last updated: 2026-06-16
> Version: 1.0.0

---

## 1. Purpose and Vision

Daemonic is a tray-first macOS desktop app for inspecting and controlling launchd jobs. It gives operators fast menu bar access, safe user-agent control, and local AI assistance for diagnosing and proposing fixes to launchd services.

The product has two hard constraints that must never erode:

1. **Arbitrary model output is never executed as shell text.** All model-proposed mutations are classified into known launchd operations and executed only by deterministic Rust helpers after explicit approval.
2. **System Agents and System Daemons are read-only.** Mutation operations are limited to User Agents under `~/Library/LaunchAgents`.

---

## 2. Ownership

| Concern | Layer |
|---|---|
| launchctl execution and plist parsing | Rust backend (`src-tauri/src/`) |
| Job listing, control, and health UI | React frontend (`src/`) |
| Tauri IPC contract | `src/lib/invoke.ts` |
| Generated UI primitives | `src/components/ui/` (shadcn/ui — do not edit manually) |
| Fake Tauri IPC for tests | `src/test-utils/tauri-mock.ts` |
| Sidecar metadata index | `~/Library/Application Support/Daemonic/service-overrides.json` |

---

## 3. Safety Invariants

These rules are non-negotiable. Any change that weakens them requires an explicit safety review and rationale before merging.

1. **No arbitrary shell execution.** Model output is parsed into a structured proposal. Only proposals classified as one of: `start`, `stop`, `restart`, `kickstart`, `enable`, or `disable` may proceed to execution. Ambiguous or unclassified proposals are rejected by the Rust backend.
2. **System jobs are read-only.** Mutation commands (start, stop, restart, kickstart, enable, disable, edit, delete) must check that the target plist path is under `~/Library/LaunchAgents` before proceeding. System paths (`/Library/LaunchAgents`, `/Library/LaunchDaemons`) must never be mutated.
3. **Approval gate is mandatory.** The agent panel requires explicit user confirmation before any proposed action is applied. Semi-autonomous mode auto-applies only safe user-agent start/kickstart proposals — stop, restart, disable, system-owned jobs, and ambiguous proposals remain locked behind manual approval regardless of mode.
4. **Audit trail is complete.** Every model interaction records: prompt, job context, structured result, raw model response, and runtime command line. The audit trail is not optional.
5. **Model credentials never persist.** The app does not store API keys, tokens, or remote model credentials. The assistant panel is local-only (Ollama, llama.cpp/yama.cpp, or custom local CLI).

---

## 4. Architecture Boundaries

| Boundary | Rule |
|---|---|
| Rust backend | Owns all launchctl invocations, plist read/write, and action classification. The frontend must not invoke shell commands directly. |
| React frontend | Owns presentation, timeline state, and provider configuration UI. All mutations go through typed Tauri IPC (`src/lib/invoke.ts`). |
| IPC contract | Changes to Tauri command signatures require coordinated frontend and backend changes with updated fake handlers in `src/test-utils/tauri-mock.ts`. |
| shadcn/ui components | `src/components/ui/` is generated output. Do not edit manually unless the change cannot be expressed through component props or composition. |
| Sidecar index | `service-overrides.json` is a durable metadata store for grouping, tags, health config, and port visibility. It augments plist data and must never store secrets or credential material. |

---

## 5. Code Conventions

- **TypeScript**: use `type` not `interface`. Keep types co-located with the code that uses them.
- **Rust**: follow `cargo fmt` and `cargo clippy -- -D warnings`. No `#[allow(warnings)]` suppressions without a comment explaining the exception.
- **Language**: all code comments, commit messages, doc strings, and project documentation are in English.
- **Package manager**: `pnpm` only. Do not commit `npm` or `yarn` lock files.
- **Tauri commands**: `pnpm tauri` / `pnpm exec tauri`. Do not use `cargo tauri`.
- **Cargo environment**: always prefix cargo commands with `RUSTUP_HOME=$HOME/.rustup` in this environment.

---

## 6. Testing Rules

- All new Tauri command paths require a Rust unit test covering the success case and at least one error/rejection case.
- All new frontend agent timeline state transitions require a vitest test using `setFakeHandler()` / `resetFakeHandlers()` from the fake Tauri IPC layer.
- Do not use `vi.mock()` for `@tauri-apps/api/core` — the vitest alias to `src/test-utils/tauri-mock.ts` is the approved approach.
- Frontend tests for agent features must include at least one system-agent case asserting that mutation controls are absent or disabled.

---

## 7. Verification Commands

All of the following must pass before a PR is merged or a release is cut:

```bash
pnpm typecheck
pnpm build
pnpm test
pnpm lint
RUSTUP_HOME=$HOME/.rustup cargo test --manifest-path src-tauri/Cargo.toml
RUSTUP_HOME=$HOME/.rustup cargo fmt --manifest-path src-tauri/Cargo.toml --check
RUSTUP_HOME=$HOME/.rustup cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
```

---

## 8. Release Rules

1. Version bumps use the `pnpm version:patch`, `pnpm version:minor`, or `pnpm version:major` scripts — these commit and tag in one step.
2. The release artifact is `src-tauri/target/release/bundle/macos/Daemonic.app`. The `src-tauri/target/` tree is disposable compiler output and is not the distributed artifact.
3. The app is unsigned. Release notes must include the quarantine removal step (`xattr -cr`) for users installing from a tarball.
4. No release ships with `BLOCKER` findings from a code review pass.

---

## 9. Commit Conventions

Format: `type(scope): description`

| Type | When |
|---|---|
| `feat` | New feature |
| `fix` | Bug fix |
| `refactor` | Code restructure, no behavior change |
| `test` | Adding or updating tests |
| `docs` | Documentation only |
| `chore` | Dependencies, scripts, CI |
| `perf` | Performance improvement |

- Subject line: max 72 chars, imperative mood.
- Reference issues when applicable: `Closes #123`.
- Breaking changes to the IPC contract: `feat(ipc)!:`.

---

## 10. What This App Does Not Do

- Does not execute arbitrary shell text from model output.
- Does not mutate System Agents or System Daemons.
- Does not store remote API keys or model credentials.
- Does not connect to remote LLM APIs — all assistant inference is local.
- Does not auto-apply destructive actions (stop, restart, disable) without explicit user confirmation, even in semi-autonomous mode.

---

## 11. Changing This Document

1. Propose the change in a PR with a brief rationale.
2. Changes to the Safety Invariants section require a written justification explaining why the safety property is preserved or deliberately relaxed.
3. All other changes follow normal PR review.
4. Update `Last updated` date on every merge.
