#!/usr/bin/env bash
# Build dist/Oedipa-v<version>.dmg from already-signed-and-stapled AU
# + VST3 + CLAP bundles (version parsed from vst/CMakeLists.txt).
# ADR 009 Phase 4; CLAP added in ADR 010 Phase 7. Run after
# codesign.sh + notarize.sh.
#
# The dmg itself is also signed, notarized, and stapled — belt-and-braces
# so users who extract bundles before Gatekeeper checks the dmg still get
# stapled bundles.

set -euo pipefail

if [[ -z "${DEVELOPER_TEAM_ID:-}" ]]; then
  echo "error: DEVELOPER_TEAM_ID env var not set" >&2
  exit 1
fi

NOTARY_PROFILE="${NOTARY_PROFILE:-im9-notary}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VST_DIR="$SCRIPT_DIR/.."
ARTEFACTS_DIR="$VST_DIR/build/Oedipa_artefacts/Release"
DIST_DIR="$VST_DIR/../dist"
INSTALL_TXT="$SCRIPT_DIR/INSTALL.txt"
README_TXT="$SCRIPT_DIR/README.txt"

# Parse version from CMakeLists.txt (single source of truth — same line
# build-pkg.sh reads; substituted into the __VERSION__ token in
# INSTALL.txt and README.txt headers when staging, and embedded in the
# output filename + dmg volume name).
VERSION="$(grep -E '^project\(Oedipa VERSION' "$VST_DIR/CMakeLists.txt" \
  | sed -E 's/.*VERSION ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
if [[ -z "$VERSION" ]]; then
  echo "error: could not parse version from $VST_DIR/CMakeLists.txt" >&2
  exit 1
fi
echo "Version: $VERSION"

DMG_PATH="$DIST_DIR/Oedipa-v$VERSION.dmg"

AU_BUNDLE="$ARTEFACTS_DIR/AU/Oedipa.component"
VST3_BUNDLE="$ARTEFACTS_DIR/VST3/Oedipa.vst3"
CLAP_BUNDLE="$ARTEFACTS_DIR/CLAP/Oedipa.clap"

for bundle in "$AU_BUNDLE" "$VST3_BUNDLE" "$CLAP_BUNDLE"; do
  if [[ ! -e "$bundle" ]]; then
    echo "error: bundle not found at $bundle" >&2
    echo "  hint: run \`make build && ./scripts/codesign.sh && ./scripts/notarize.sh\` first" >&2
    exit 1
  fi
done

for txt in "$INSTALL_TXT" "$README_TXT"; do
  if [[ ! -f "$txt" ]]; then
    echo "error: $(basename "$txt") not found at $txt" >&2
    exit 1
  fi
done

mkdir -p "$DIST_DIR"

STAGING="$(mktemp -d -t oedipa-dmg)"
trap 'rm -rf "$STAGING"' EXIT

echo "Staging dmg contents in $STAGING"
cp -R "$AU_BUNDLE" "$STAGING/"
cp -R "$VST3_BUNDLE" "$STAGING/"
cp -R "$CLAP_BUNDLE" "$STAGING/"
# Substitute __VERSION__ in the header of each doc when staging. Source
# files keep the placeholder so the in-tree text is version-agnostic.
sed "s/__VERSION__/v$VERSION/g" "$INSTALL_TXT" > "$STAGING/INSTALL.txt"
sed "s/__VERSION__/v$VERSION/g" "$README_TXT"  > "$STAGING/README.txt"

echo "Creating $DMG_PATH (HFS+, UDZO compressed)"
rm -f "$DMG_PATH"
hdiutil create \
  -volname "Oedipa v$VERSION" \
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
