# Changelog

## [Unreleased]

### Fixed

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
