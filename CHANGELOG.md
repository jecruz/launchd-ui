# Changelog

## [Unreleased]

### Fixed

- Starting a user agent no longer stops a running job first, including automatic Start actions.

- Disable execution of command-based health checks from service metadata. Services with only a health check command report `unknown` and request a health check URL.
- Restrict health probes to HTTP(S) loopback destinations with a five-second check budget and 64 KiB response limit; disable redirects/proxies and retain status only.
- Validate user-agent containment and plist/request labels on all job mutations; reject traversal, symlinks, hardlinks, raw identity changes, undeclared log clearing, and sensitive automatic actions.
