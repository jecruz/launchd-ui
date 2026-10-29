#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_BUNDLE="${ROOT_DIR}/src-tauri/target/release/bundle/macos/Daemonic.app"
DMG_DIR="${ROOT_DIR}/src-tauri/target/release/bundle/dmg"
VERSION="$(node -p "require(process.argv[1]).version" "${ROOT_DIR}/package.json")"
DMG_PATH="${DMG_DIR}/Daemonic_${VERSION}_aarch64-signed.dmg"
STAGING_DIR="$(mktemp -d /private/tmp/Daemonic-dmg.XXXXXX)"

cleanup() {
  rm -rf "${STAGING_DIR}"
}

trap cleanup EXIT

mkdir -p "${DMG_DIR}"
ditto "${APP_BUNDLE}" "${STAGING_DIR}/Daemonic.app"
ln -s /Applications "${STAGING_DIR}/Applications"

hdiutil create \
  -volname "Daemonic" \
  -srcfolder "${STAGING_DIR}" \
  -ov \
  -format UDZO \
  "${DMG_PATH}"

codesign --force --sign - "${DMG_PATH}"
codesign --verify --deep --strict "${DMG_PATH}"
hdiutil verify "${DMG_PATH}"

printf '%s\n' "${DMG_PATH}"
