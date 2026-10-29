# Changelog

## [Unreleased]

### Added

- Integrate upstream Home filtering, direct Run now controls, system/light/dark theme selection, and display-only copyable launchctl commands; system jobs offer read-only inspection.
- Verify synchronized release manifests and release-workflow behavior with the upstream Node test suite adapted to Daemonic; roll back caught manifest replacement failures and retain conflict recovery snapshots.
- Require issue-linked release PRs targeting main, explicit CI validation for token-created branches, and matching release branch/title/manifests before publication.

### Changed

- Synchronize Daemonic manifests at 1.4.2 and adopt the upstream Rust security-dependency baseline while retaining bounded native-TLS health probes and tray support.
- Document DB2 examples as preserved, nonshipping, unvalidated historical material and distinguish source milestones from installed-runtime acceptance.

### Fixed

- Bind job details, health probes, diagnosis and log viewing to listed, owned, contained plist identities; validate before network I/O and read diagnosis logs only from the pinned owning plist's declarations.

- Preserve explicit health URLs in repair suggestions and retain failed health results ahead of unrelated stderr context.

- Keep explicit health destinations authoritative, preserve existing ports during repairs, and store health observations without freezing external plist metadata.
- Reject empty or misspelled calendar schedules, label the Monday preset accurately, and include month constraints in schedule descriptions.
- Report saved metadata separately from failed refreshes and show repair suggestions independently of cached health status.

- Reject malformed raw schedule values before every parse so invalid integers cannot become wildcard schedules; preserve original XML comments.
- Capture and sync deletion targets before removing them, bind log reads to declared destinations, and protect UI input during preference bootstrap.
- Preserve successful action results after refresh failures, block concurrent suggested fixes, display generated risks, and reject invalid manual port values.

- Make the typecheck command check referenced TypeScript projects, matching production compilation.
- Preserve original plist identities through transactions and atomic exchange; reject competing replacements and retain unresolved conflicts for operator review.
- Block saving incomplete restored drafts and validate raw port elements before conversion.
- Serialize and atomically save private preferences and metadata; recover interrupted plist/metadata transactions and preserve conflicting external edits.
- Omit command arguments, environment values, and raw plist content from durable drafts, with an explicit restoration notice.
- Flush pending preferences on close/quit, expose persistence failures, recover off-screen windows, and reject stale detail, log, prompt, and form results.
- Continue bulk actions after individual failures and refresh partial results; use persisted table sorting; honor explicit metadata clears.
- Validate schedule domains and port conversions, retain health-result-only metadata, bound log reads, and require fresh probe evidence for healthy status.
- Restrict prospective log paths to private owned parents; support Clipboard API rejection fallback and invalid timestamp handling.

- Starting a user agent no longer stops a running job first, including automatic Start actions; loaded idle jobs start without the kill flag.
- Reject replaced plist inodes, invalid log directories, and stale automatic proposal targets; retain system-job health observations in app-owned state.

- Disable execution of command-based health checks from service metadata. Services with only a health check command report `unknown` and request a health check URL.
- Restrict health probes to HTTP(S) loopback destinations with a five-second check budget and 64 KiB response limit; disable redirects/proxies and retain status only.
- Validate user-agent containment and plist/request labels on all job mutations; reject traversal, symlinks, hardlinks, raw identity changes, undeclared log clearing, and sensitive automatic actions.
