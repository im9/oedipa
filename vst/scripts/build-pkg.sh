#!/usr/bin/env bash
# Build dist/Oedipa.pkg installer from already-signed-notarized-and-stapled
# AU + VST3 + CLAP bundles. Companion to build-dmg.sh; both produced by
# `make release-vst`. Run after codesign.sh + notarize.sh.
#
# The pkg itself is also signed (Developer ID Installer), notarized, and
# stapled — so Gatekeeper accepts the installer before the contained
# bundles are extracted.

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
PKG_PATH="$DIST_DIR/Oedipa.pkg"
DIST_XML_TEMPLATE="$SCRIPT_DIR/distribution.xml"
PKG_RESOURCES="$SCRIPT_DIR/pkg-resources"

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

if [[ ! -f "$DIST_XML_TEMPLATE" ]]; then
  echo "error: distribution.xml not found at $DIST_XML_TEMPLATE" >&2
  exit 1
fi

if [[ ! -d "$PKG_RESOURCES" ]]; then
  echo "error: pkg-resources/ not found at $PKG_RESOURCES" >&2
  exit 1
fi

# Parse version from CMakeLists.txt (single source of truth, same line
# the release skill bumps).
VERSION="$(grep -E '^project\(Oedipa VERSION' "$VST_DIR/CMakeLists.txt" \
  | sed -E 's/.*VERSION ([0-9]+\.[0-9]+\.[0-9]+).*/\1/')"
if [[ -z "$VERSION" ]]; then
  echo "error: could not parse version from $VST_DIR/CMakeLists.txt" >&2
  exit 1
fi
echo "Version: $VERSION"

mkdir -p "$DIST_DIR"
STAGING="$(mktemp -d -t oedipa-pkg)"
trap 'rm -rf "$STAGING"' EXIT

# Stage each format under its target install path. install-location "/" +
# absolute /Library/... in the staging tree lets the macOS installer's
# domain machinery redirect to ~/Library/... when the user picks
# "Install for me only" (see distribution.xml comments).
echo "Staging bundles"
mkdir -p "$STAGING/vst3/Library/Audio/Plug-Ins/VST3"
mkdir -p "$STAGING/au/Library/Audio/Plug-Ins/Components"
mkdir -p "$STAGING/clap/Library/Audio/Plug-Ins/CLAP"
cp -R "$VST3_BUNDLE" "$STAGING/vst3/Library/Audio/Plug-Ins/VST3/"
cp -R "$AU_BUNDLE"   "$STAGING/au/Library/Audio/Plug-Ins/Components/"
cp -R "$CLAP_BUNDLE" "$STAGING/clap/Library/Audio/Plug-Ins/CLAP/"

echo "Building VST3 component pkg"
pkgbuild --root "$STAGING/vst3" \
         --identifier "fm.im9.oedipa.vst3" \
         --version "$VERSION" \
         --install-location "/" \
         "$STAGING/Oedipa-VST3.pkg"

echo "Building AU component pkg"
pkgbuild --root "$STAGING/au" \
         --identifier "fm.im9.oedipa.au" \
         --version "$VERSION" \
         --install-location "/" \
         "$STAGING/Oedipa-AU.pkg"

echo "Building CLAP component pkg"
pkgbuild --root "$STAGING/clap" \
         --identifier "fm.im9.oedipa.clap" \
         --version "$VERSION" \
         --install-location "/" \
         "$STAGING/Oedipa-CLAP.pkg"

# Substitute version placeholder and run productbuild.
DIST_XML="$STAGING/distribution.xml"
sed "s/__VERSION__/$VERSION/g" "$DIST_XML_TEMPLATE" > "$DIST_XML"

# Stage pkg-resources to a temp tree so __VERSION__ in the welcome /
# conclusion screens (both en + ja lproj) can be substituted. Same token
# convention as distribution.xml above. Single source of truth =
# CMakeLists.
STAGED_RESOURCES="$STAGING/pkg-resources"
cp -R "$PKG_RESOURCES" "$STAGED_RESOURCES"
find "$STAGED_RESOURCES" -type f -name '*.txt' -exec \
  sed -i '' "s/__VERSION__/v$VERSION/g" {} +

echo "Assembling distribution pkg"
productbuild --distribution "$DIST_XML" \
             --package-path "$STAGING" \
             --resources "$STAGED_RESOURCES" \
             "$STAGING/Oedipa-unsigned.pkg"

# productsign auto-selects the "Developer ID Installer" identity that
# matches the team ID (distinct from the "Developer ID Application" cert
# codesign.sh uses for the bundles).
echo "Signing $PKG_PATH"
rm -f "$PKG_PATH"
productsign --sign "$DEVELOPER_TEAM_ID" \
            "$STAGING/Oedipa-unsigned.pkg" \
            "$PKG_PATH"
pkgutil --check-signature "$PKG_PATH"

echo "Submitting $PKG_PATH to notarytool ($NOTARY_PROFILE)"
xcrun notarytool submit "$PKG_PATH" \
  --keychain-profile "$NOTARY_PROFILE" \
  --wait

echo "Stapling $PKG_PATH"
xcrun stapler staple "$PKG_PATH"
xcrun stapler validate "$PKG_PATH"

echo "pkg ready: $PKG_PATH"
