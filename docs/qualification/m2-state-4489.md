# Durable state qualification — Redmine #4489

Milestone 2 of #4487, based on security branch `fix/daemonic-m1-security-4488` at `aec0b65`. Source, fixture and uninstalled-build evidence only. No Daemonic installation, app launch, service launch, provider inference or real job mutation was performed.

## Behavior and acceptance evidence

- Native draft enum round trips cover all nine schedule/hour combinations and legacy enum spellings. Old payloads can omit metadata. Durable drafts omit command arguments, environment values and raw plist text, with a restoration notice and saving blocked until an authoritative reload or new draft. Historical legacy files are retained.
- Private state writes serialize across processes, use bounded reads and synced atomic replacement. Concurrent read/modify/write tests retain all 80 updates. Serialization failure preserves the last snapshot. A private journal rolls back replacement, creation and deletion when paired metadata persistence fails; interrupted recovery and conflicting external edits are tested. External conflicts retain the journal and fail closed. File recovery does not restart a service stopped before a failed deletion.
- UI preference saves coalesce and serialize, retain failed snapshots for retry, and flush before close/quit. A component test proves failed flush leaves the window visible. Malformed preference loading pauses autosave; explicit reload protects unsaved in-memory edits. Geometry is fitted to attached displays.
- Deferred-response tests cover older lists, logs, details, diagnoses and saved forms finishing after a newer selection. Sensitive automatic-action stale-target tests remain from milestone 1. Partial bulk failure continues remaining jobs and refreshes the resulting list. Table sorting is controlled by persisted state.
- Calendar/interval/hour and port domains are validated before mutation, including model drafts and raw plist schedules. Day/Weekday use launchd OR semantics; Sunday 7 is accepted. Repair snapshots permit explicit clears. Historical healthy startup text and timestamp-free stderr cannot erase non-zero exit evidence. Healthy display requires a running service and a probe no older than five minutes, with future timestamps rejected.
- Log reads consume at most 256 KiB and return at most 2,000 lines. Named pipes are opened nonblocking and rejected as non-regular files. Prospective log parents must be private, owned and nonlinked. The app prepares its private log directory only on a separately authorized launch.
- Clipboard API rejection uses the cleaned-up fallback. Extreme invalid dates render a dash; empty log copies use actual empty content.

Commands run through `/Users/jeffreycruz/.local/bin/heavy-op`: `cargo test --locked`, `cargo clippy --locked -- -D warnings`, formatting, TypeScript project compilation, lint, Vitest, and `pnpm exec tauri build --bundles app --ci -- --locked`. Full command lines and results are retained in `/Users/jeffreycruz/Development/qualification-evidence/daemonic-finish-20261029/m2/`.

Production compilation exposed that the previous `tsc --noEmit` script checked only an empty solution config. The typecheck command now uses `tsc -b`, matching the actual referenced projects. Two new type mismatches were corrected before the final build. Earlier failed development logs remain evidence, not passing receipts.

## Verification result

Final source checks passed: 56 Rust tests, 111 frontend tests, `cargo clippy` with warnings denied, formatting, `tsc -b`, lint with zero warnings/errors, and a production app bundle. The app was not installed or launched. The frontend tests retain an existing Radix missing-description warning in JobDetail; Vite reports the approximately 508 KiB minified application chunk. Neither is a failing test or runtime acceptance claim.

Independent review `584723f8-a7ea-405d-a7d0-007a936febd3` returned zero criticals and ten warnings. All ten received bounded corrections before the first gate push: retain the command's original file identity inside the transaction; reject raw invalid port elements; compact binary-safe base64 journal snapshots with maximum 1 MiB before/after fixtures; atomically exchange and validate displaced plists with a deterministic post-precheck race fixture; recover from rejected window geometry operations; invalidate delayed list edits on every form opening; refresh persisted metadata after failed health verification; block saving omitted restored drafts; reject invalid calendar bases before range expansion; and display both Day/Weekday OR constraints. The new dependency declaration promotes the already-locked base64 0.22.1 package; no transitive version changed. Review receipt and gate evidence are retained in the evidence directory.

## Original review disposition

IDs refer to the unchanged Phase 2 assessment at `/Users/jeffreycruz/Development/qualification-evidence/daemonic-assessment-20261029.md`. A warning is a reviewer observation, not automatically a reproduced defect.

| Finding | Disposition |
| --- | --- |
| C1 shell health execution | Disabled in rescue correction `721d5db`; negative regression retained. |
| C2 / W06 curl URL injection, schemes and unbounded response | Closed in milestone 1 with validated native loopback HTTP(S), five-second shared budget, 64 KiB limit, redirects/proxies disabled and status-only persistence. |
| W01 stale DMG input | Milestone 4 #4491, remains open until packaging qualification. |
| W02 destructive installer | Milestone 4 #4491, remains open; installer not invoked. |
| W03 LSBackgroundOnly | Milestone 4 #4491, remains open; no activation claim. |
| W04 plaintext draft containers | Omitted from durable snapshots; private atomic storage; old app preferences sanitized on load. Legacy copies retained and explicitly documented. |
| W05 unbounded log tail | Bounded byte/line reads and special-file rejection tested. |
| W07 historical Hermes success override | Removed; independent failure remains authoritative. |
| W08 timestamp-free stderr downgrade | Removed; regression now expects non-zero exit failure. |
| W09 unsupported DB2 index/performance claim | Milestone 3 #4490 scope/archival decision; no DB2 validation claim. |
| W10 undefined DB2 SQL | Milestone 3 #4490; preserved historical corpus, not runtime acceptance. |
| W11 wrapping port casts | Checked narrowing rejects zero/out-of-range values. |
| W12 result-only metadata omitted | All result fields participate in serialization; true result-only fixture added. |
| W13 non-atomic/concurrent overlay writes | Private writer lock, atomic replacement and paired recovery journal. |
| W14 empty/None cannot clear | New complete snapshots honor clears; legacy partial records explicitly retain inheritance. |
| W15 out-of-order preference saves | Coalesced serialized queue, explicit flush and visible retry. |
| W16 bulk failure skips refresh | Continues each remaining action; always refreshes; partial failure component test. |
| W17 stale detail/diagnosis | Selection generations and deferred negative tests. |
| W18 inherited template keys | Own-property lookup rejects inherited names. |
| W19 one-time form initialization | Explicit target/draft rehydration and reopen/deferred-save tests. |
| W20 model schedule domains | Shared domain validation, no silent clamping; migration requires schedule/environment/port schema fields. |
| W21 predicted Edit assertion failure | Not reproduced in Phase 2 or milestone 1; original 10 JobList cases remain passing. Do not classify as a repaired failure. |
| W22 divergent table sort state | Shared persisted key/direction and callback; group is part of shared sort type. |

Second-review additional warnings: stale-installed-app README flow → #4491; paired plist/overlay partial save and ignored delete-overlay failure → journaled recoverable transaction; conflicting DB2 index names → #4490; missing metadata default → serde default; off-screen restoration → monitor work-area fitting; Clipboard API rejection → tested fallback.

Info findings: empty-log placeholder copying → actual content; extreme finite timestamp → validated date; null missing-health message → same handling as unknown. Milestone 1's prospective shared-log-parent race is tightened here by rejecting writable shared final parents and creating a private app log directory on future authorized startup. Runtime CLI timeout/cancellation/locality remains milestone 5 #4492 before any launch acceptance.

## Boundary

Main remains at `aa6233c`; the rescue branch remains at `721d5db`. Work proceeds on milestone branches. The quarantined unsafe app remains at `/Users/jeffreycruz/Development/qualification-evidence/daemonic-installed-unsafe-20261029/Daemonic.app`. It is not approved for launch. Source tests and a production build do not establish installed-runtime safety or feature-ticket completion.
