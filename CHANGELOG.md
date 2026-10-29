# Changelog

## [Unreleased]

### Fixed

- Disable execution of command-based health checks from service metadata. Services with only a health check command report `unknown` and request a health check URL.
