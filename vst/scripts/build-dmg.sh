#!/usr/bin/env bash
# Build dist/Oedipa.dmg from already-signed-and-stapled AU + VST3 bundles.
# ADR 009 Phase 4. Run after codesign.sh + notarize.sh.
#
# The dmg itself is also signed, notarized, and stapled — belt-and-braces
# so users who extract bundles before Gatekeeper checks the dmg still get
# stapled bundles.

set -euo pipefail

if [[ -z "${DEVELOPER_TEAM_ID:-}" ]]; then
  echo "error: DEVELOPER_TEAM_ID env var not set" >&2
  exit 1
fi

NOTARY_PROFILE="${NOTARY_PROFILE:-oedipa-notary}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTEFACTS_DIR="$SCRIPT_DIR/../build/Oedipa_artefacts/Release"
DIST_DIR="$SCRIPT_DIR/../../dist"
DMG_PATH="$DIST_DIR/Oedipa.dmg"
INSTALL_TXT="$SCRIPT_DIR/INSTALL.txt"

AU_BUNDLE="$ARTEFACTS_DIR/AU/Oedipa.component"
VST3_BUNDLE="$ARTEFACTS_DIR/VST3/Oedipa.vst3"

for bundle in "$AU_BUNDLE" "$VST3_BUNDLE"; do
  if [[ ! -e "$bundle" ]]; then
    echo "error: bundle not found at $bundle" >&2
    echo "  hint: run \`make build && ./scripts/codesign.sh && ./scripts/notarize.sh\` first" >&2
    exit 1
  fi
done

if [[ ! -f "$INSTALL_TXT" ]]; then
  echo "error: INSTALL.txt not found at $INSTALL_TXT" >&2
  exit 1
fi

mkdir -p "$DIST_DIR"

STAGING="$(mktemp -d -t oedipa-dmg)"
trap 'rm -rf "$STAGING"' EXIT

echo "Staging dmg contents in $STAGING"
cp -R "$AU_BUNDLE" "$STAGING/"
cp -R "$VST3_BUNDLE" "$STAGING/"
cp "$INSTALL_TXT" "$STAGING/"

echo "Creating $DMG_PATH (HFS+, UDZO compressed)"
rm -f "$DMG_PATH"
hdiutil create \
  -volname "Oedipa" \
  -srcfolder "$STAGING" \
  -format UDZO \
  -fs HFS+ \
  "$DMG_PATH"

echo "Signing $DMG_PATH"
codesign --force --sign "$DEVELOPER_TEAM_ID" --timestamp "$DMG_PATH"
codesign --verify --verbose=2 "$DMG_PATH"

echo "Submitting $DMG_PATH to notarytool ($NOTARY_PROFILE)"
xcrun notarytool submit "$DMG_PATH" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait

echo "Stapling $DMG_PATH"
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$DMG_PATH"

echo "hdiutil verify"
hdiutil verify "$DMG_PATH"

echo "dmg ready: $DMG_PATH"
