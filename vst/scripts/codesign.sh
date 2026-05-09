#!/usr/bin/env bash
# Sign AU + VST3 + CLAP bundles with Developer ID Application + hardened
# runtime. ADR 009 Phase 2; CLAP added in ADR 010 Phase 7.

set -euo pipefail

if [[ -z "${DEVELOPER_TEAM_ID:-}" ]]; then
  echo "error: DEVELOPER_TEAM_ID env var not set" >&2
  echo "  hint: export DEVELOPER_TEAM_ID=XXXXXXXXXX" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/entitlements.plist"
ARTEFACTS_DIR="$SCRIPT_DIR/../build/Oedipa_artefacts/Release"

sign_bundle() {
  local bundle="$1"
  if [[ ! -e "$bundle" ]]; then
    echo "error: bundle not found at $bundle" >&2
    echo "  hint: run \`make build\` first" >&2
    exit 1
  fi
  echo "Signing $bundle"
  codesign \
    --force \
    --sign "$DEVELOPER_TEAM_ID" \
    --options runtime \
    --entitlements "$ENTITLEMENTS" \
    --timestamp \
    "$bundle"
  codesign --verify --deep --strict --verbose=2 "$bundle"
}

sign_bundle "$ARTEFACTS_DIR/AU/Oedipa.component"
sign_bundle "$ARTEFACTS_DIR/VST3/Oedipa.vst3"
sign_bundle "$ARTEFACTS_DIR/CLAP/Oedipa.clap"

echo "Signed and verified: AU + VST3 + CLAP"
