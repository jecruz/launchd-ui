#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${ROOT_DIR}/src-tauri/target/release/bundle/macos/Daemonic.app"
INSTALL_PATH="/Applications/Daemonic.app"

if [[ ! -d "${APP_BUNDLE}" ]]; then
  printf 'Expected built app bundle at %s\nRun pnpm tauri:build first.\n' "${APP_BUNDLE}" >&2
  exit 1
fi

if [[ -e "${INSTALL_PATH}" ]]; then
  rm -rf "${INSTALL_PATH}"
fi

ditto "${APP_BUNDLE}" "${INSTALL_PATH}"
xattr -cr "${INSTALL_PATH}" || true

printf 'Installed %s\n' "${INSTALL_PATH}"
