# Daemonic delivery roadmap — #4487

Updated 2026-10-29. The user approved FINISH in five ordered milestones. Earlier FUBAR DONE labels described source slices; they did not prove installed-runtime acceptance. This roadmap supersedes those completion claims. The quarantined historical app is unsafe to launch.

| Milestone | Ticket | Status and checkable acceptance |
| --- | --- | --- |
| 1. Mutation and probe security | #4488 | Source complete on reviewed remote branch: native loopback HTTP(S), deadline/size limits, no shell health execution; every mutation binds owned contained plist/label; negative tests. Rescue commits published and verified. |
| 2. Durable state and UI races | #4489 | Source complete through `b39fc55`: 63 Rust/121 frontend tests; private atomic state, paired recovery, stale-result rejection, schedule validation, preference flush and explicit partial-success behavior. Production build only. |
| 3. Upstream and scope | #4490 | Integration in progress on `integrate/daemonic-upstream-4490`; eight upstream commits through `d0ea653`, synchronized 1.4.2 manifests, preserved security/state guarantees, checked dependency lock and all source checks. Review and report before any merge into rescue. DB2 retained as nonshipping historical material. |
| 4. Packaging and distribution | #4491 | Pending. Rebuild from identified source; remove stale DMG input and destructive replacement; document install/update/uninstall/verification and app activation behavior. Test installer only after separate user authorization through %202. |
| 5. Real runtime acceptance | #4492 | Pending. Bound provider subprocess duration/output and cancellation; verify local-only provider behavior. After separate user launch permission, prove installed provenance, tray/window/quit, preferences and safe fixture actions, model readiness/failure, approval and auto-action policy. |

## Feature acceptance matrix

Feature tickets remain In Progress at 50% until their remaining evidence is accepted. Source/fake-IPC tests cannot establish real WebView, launchd, model-runtime or privacy behavior.

| Ticket | Implemented source evidence | Remaining acceptance |
| --- | --- | --- |
| #422 Agent-driven copilot | Prompt/context UI, structured proposals, explicit confirmation, native action classification, target binding, audit and refresh tests. | Authorized installed end-to-end prompt → approval → fixture mutation → independently observed result; denied/system actions remain blocked. |
| #423 Local embedded model | Configurable Ollama, llama.cpp/yama.cpp and local CLI adapters, readiness details and smoke UI. | Provider subprocess deadlines/output/cancellation and locality hardening, actual local inference and unavailable-model behavior. There is no bundled embedded model. |
| #424 Redmine workflow | Parent #4487 and five child Tasks in project 56; issue-linked commits, evidence paths, gate and boundary notes through sanctioned Redmine MCP. | Repeatable final handoff and issue updates after packaging/runtime milestones; no automatic in-app Redmine sync is claimed. |
| #425 Full assistant | Text input, current-job context, in-session conversation history, proactive local signals and quick proposals. | Authorized installed-runtime acceptance and documented in-session history limits. Durable sensitive conversation storage is not added implicitly. |
| #426 Semi-autonomous policy | Opt-in auto-apply only for classified user-agent Start/Kickstart; sensitive/system proposals require manual review or rejection; negative backend/UI tests. | Authorized fixture-based installed proof of safe auto actions, sensitive approval prompts, stale-target rejection and audit results. |

## Verification and decision boundaries

All source tests, lint, formatting, type checking, dependency fetches and builds run through `/Users/jeffreycruz/.local/bin/heavy-op`. Commands and artifact hashes live under `/Users/jeffreycruz/Development/qualification-evidence/daemonic-finish-20261029/`. Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm test:release`, `pnpm version:check`, `cargo test --locked`, `cargo fmt --check`, `cargo clippy --locked -- -D warnings` and the uninstalled app production build against the integration result.

Main stays at `aa6233c`; rescue stays at `721d5db` until explicitly authorized. Work stays on descendant milestone branches. The M3 integration must be reported before merging into rescue. Daemonic installation and app launch each require separate user approval through %202; build success never grants either approval. No main merge is authorized.
