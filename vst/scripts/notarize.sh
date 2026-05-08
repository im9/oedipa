#!/usr/bin/env bash
# Notarize signed AU + VST3 bundles via xcrun notarytool, then staple.
# ADR 009 Phase 3. Requires bundles to be signed first (codesign.sh).

set -euo pipefail

NOTARY_PROFILE="${NOTARY_PROFILE:-oedipa-notary}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ARTEFACTS_DIR="$SCRIPT_DIR/../build/Oedipa_artefacts/Release"

# notarytool requires .zip / .pkg / .dmg input — bundles cannot submit as
# raw directories. Zip the bundle, submit, staple the original (not the
# zip) so the ticket lives inside the bundle end users install.
notarize_bundle() {
  local bundle="$1"
  if [[ ! -e "$bundle" ]]; then
    echo "error: bundle not found at $bundle" >&2
    echo "  hint: run \`make build\` and \`vst/scripts/codesign.sh\` first" >&2
    exit 1
  fi

  local zip_path="$bundle.zip"
  echo "Zipping $bundle"
  rm -f "$zip_path"
  ditto -c -k --keepParent "$bundle" "$zip_path"

  echo "Submitting to notarytool ($NOTARY_PROFILE)"
  xcrun notarytool submit "$zip_path" \
    --keychain-profile "$NOTARY_PROFILE" \
    --wait

  echo "Stapling $bundle"
  xcrun stapler staple "$bundle"
  xcrun stapler validate "$bundle"

  rm -f "$zip_path"
}

notarize_bundle "$ARTEFACTS_DIR/AU/Oedipa.component"
notarize_bundle "$ARTEFACTS_DIR/VST3/Oedipa.vst3"

echo "Notarized and stapled: AU + VST3"
