#!/usr/bin/env bash
# Verify the build produced every expected plug-in format.
#
# Used by `make build` as the build-system assertion (ADR 010 Phase 1 for
# CLAP, generic VST3 / AU / Standalone presence check otherwise). Exits
# non-zero on the first missing artefact set, listing all missing paths.
#
# Usage: ./scripts/check-artefacts.sh [BUILD_DIR] [CONFIG]
# Defaults: BUILD_DIR=build CONFIG=Release

set -eu

BUILD_DIR="${1:-build}"
CONFIG="${2:-Release}"
ARTEFACT_ROOT="${BUILD_DIR}/Oedipa_artefacts/${CONFIG}"

EXPECTED=(
    "${ARTEFACT_ROOT}/VST3/Oedipa.vst3"
    "${ARTEFACT_ROOT}/AU/Oedipa.component"
    "${ARTEFACT_ROOT}/Standalone/Oedipa.app"
    "${ARTEFACT_ROOT}/CLAP/Oedipa.clap"
)

missing=0
for path in "${EXPECTED[@]}"; do
    if [ -e "$path" ]; then
        printf 'ok       %s\n' "$path"
    else
        printf 'MISSING  %s\n' "$path"
        missing=$((missing + 1))
    fi
done

if [ "$missing" -gt 0 ]; then
    printf '\n%d artefact(s) missing under %s\n' "$missing" "$ARTEFACT_ROOT" >&2
    exit 1
fi
