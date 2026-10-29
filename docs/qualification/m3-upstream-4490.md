# Upstream integration qualification — #4490

Integration branch: `integrate/daemonic-upstream-4490`, based on M2 `b39fc5517a7b13c6a44d6f1cd96b5557d0be4a50`, descending from rescue `721d5db`. Main and rescue refs remain unchanged. This is source qualification and an uninstalled production build; installation, app launch, rescue merge and main merge are not authorized.

## Intake and conflict decisions

Fresh fetch on 2026-10-29 confirmed upstream `d0ea653c8346126e9047e4e3a8ef8d64bfbaddb9`. Eight commits are integrated:

| Commit | Intake |
| --- | --- |
| c446935 | Copyable launchctl commands, display only; shared clipboard fallback, visible failure/success and timer cleanup. |
| a69356c | Direct Run now control using the existing bound backend. |
| 6102dc2 | Run now available for Running/Loaded jobs, disabled for system jobs; adapted native/fake/component tests. |
| b14c0b5 | Home subset filter and native classification tests; path boundary avoids matching a sibling home prefix. Classification is a presentation heuristic, never mutation authorization. |
| a6a6de8 | System/light/dark selection with system change listener and persisted override; retain custom tray layout and adapt shell palette. |
| 2139604 | Synchronized release manifests, noncommitting bump scripts, release checks and Node tests. Adapt Cargo package identity and asset names to Daemonic. |
| c98e9b5 | Version 1.4.2 across all four manifests. |
| d0ea653 | Upstream Rust lock/security update and minimum Rust 1.88. Preserve native-TLS bounded probe features, tray support and state dependencies. |

Fifteen actual content conflicts were resolved individually (the earlier assessment predicted fourteen before M2's package-script changes). Preserve M1/M2 containment, validated labels and raw schedules, bounded probes/logs, inode checks, recovery journal, overlay semantics, preference flush, and stale-response guards. In particular, upstream's old permissive mutation helpers and create-log-directory behavior are not restored. Preserve fork metadata/log fields beside the new Home flag and controlled filtering/sorting. Retain the actual `tsc -b` project check and lint the imported release scripts.

Every upstream package/version is retained in the final lock except its app root, renamed `daemonic` at the same 1.4.2. Sixteen fork additions include the renamed root and native-TLS/tray dependencies. This is intake of the upstream security baseline, not a claim that a new advisory audit was performed. The higher minimum Rust version enables let-chain Clippy diagnostics; 15 machine-applicable collapsible-condition fixes are mechanical and covered again by the native tests. No warning allowance is weakened.

The release workflows are retained as source and checked with upstream's adapted Node assertions. They build the merge commit, verify all four manifests, and explicitly request app and DMG assets for both architectures. No workflow or release was dispatched. Redmine #1310's local CI policy was read: this public fork has not been admitted to the trusted-private local runners. No CI runtime was changed or verified.

## Scope and roadmap

The DB2 corpus remains byte-for-byte unchanged from `0e9338e`, in its original path. It is outside the shipping app, has no Rust import/embedding or Tauri resource declaration, and carries no validated performance/SQL claim. Static counts are six `undefined` queries and nine conflicting index names. Details and immutable SHA256 are in `db2-scope.md`. No SQL, model training, relocation or deletion was performed.

`ROADMAP.md` supersedes the old all-DONE FUBAR claims with the five approved delivery milestones and a #422–#426 source/runtime acceptance matrix. All five feature tickets stay In Progress at 50% until their remaining acceptance evidence is reviewed. Historical notes and user Idea #1032 are unchanged. Conversation history remains in-session; no sensitive durable conversation scope is added. Provider subprocess bounds/cancellation/locality remain #4492 before runtime acceptance.

The prior two info-level clipboard follow-ups are addressed: failed browser and fallback copying show a caught error, while successful copying exposes a tested Copied status/checkmark. No copied launchctl command is executed through IPC.

## Verification

Initial checks passed (66 Rust, 138 frontend, 25 release-script tests). Independent review `8bd22a32-c5a3-4980-9341-6c535e22123c` returned zero criticals, seven warnings and one info across three complete shards. Corrections before the first push: pin release PRs to main, require a validated Redmine input, explicitly dispatch CI for GITHUB_TOKEN-created branches, require matching release branch/title/manifests, stage manifest replacements and roll back an injected second-file replacement failure, include home WorkingDirectory/relative/shell paths in the presentation heuristic, use semantic light-mode shell colors, and offer only read-only inspection commands for system jobs. No new credential or workflow dispatch occurred.

The first production attempt correctly refused Rust Tauri 2.11 with JavaScript API 2.10. Align the locked API at 2.11.1 and repeat type checking, frontend tests and production compilation. Version writes have atomic individual replacements and caught-I/O rollback. They do not promise a four-file filesystem transaction under abrupt process termination: durable `.previous` snapshots can remain after interruption; restore the intended manifest set from Git or those snapshots, then run `pnpm version:check` before resuming. The release check fails closed on inconsistent versions. Final corrected checks pass: 66 Rust tests, 137 frontend tests, 27 Node release-script tests, rustfmt, Clippy with warnings denied, project TypeScript compilation, lint with zero warnings/errors, and version consistency. The production app rebuild passed (Rust Tauri 2.11.6 / API 2.11.1). Static Info.plist inspection confirms Daemonic 1.4.2 and the retained bundle identifier. The artifact manifest records the executable hash and source merge; the app does not yet embed a Git revision, which remains a packaging/provenance requirement for #4491. No DB2-named file is present in the app bundle. The frontend count decreases by one because two duplicated privileged-system command cases become one stronger read-only negative case. Evidence is retained at `/Users/jeffreycruz/Development/qualification-evidence/daemonic-finish-20261029/m3/`. All dependency fetches, tests and builds use `/Users/jeffreycruz/.local/bin/heavy-op`. Earlier failed diagnostic runs are not passing receipts. No installer or Daemonic executable has been run.

## Mandatory boundary

Report the reviewed integration SHA, gate, source-check counts, build/artifact identity, unchanged refs and DB2 disposition to pane %202. Stop before merging this branch into the rescue line. M4 install testing and M5 real-runtime testing additionally require the user's separate authorization through %202. The quarantined historical installed app remains unsafe to launch.
