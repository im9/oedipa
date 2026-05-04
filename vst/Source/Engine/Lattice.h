// Tonnetz lattice geometry + drag-path resolver. Pure C++17 port of the
// `TonnetzSheet.svelte` reference (inboil), per ADR 008 §UI / §Lattice.
//
// Surface stays geometry-only: vertex math, triangle build, point-in-triangle
// hit test, drag-path → P/L/R sequence resolution. Rendering, JUCE event
// dispatch, and pointer state machinery live elsewhere (Editor/, and
// PointerInteraction.h respectively).
//
// ADR 008 boundary: this header (and Lattice.cpp) MUST NOT include any
// <juce_*> header. Lattice is part of the Engine/ iOS-reuse layer; a
// JUCE include below this line is a review blocker.

#pragma once

#include "Tonnetz.h"

#include <array>
#include <vector>

namespace oedipa {
namespace engine {

struct Point2 {
    float x;
    float y;
};

// Defaults mirror inboil's `TonnetzSheet.svelte` constants exactly so the
// visual identity (palette aside) carries over. Geometry is parameterised
// so future HiDPI / iOS-touch sizing can override without forking the math.
struct LatticeGeometry {
    int colCount = 7;
    int rowCount = 5;
    float triW = 80.0f;
    float triH = 70.0f;
    float pad = 40.0f;
};

inline constexpr LatticeGeometry kDefaultLatticeGeometry{};

// Per-triangle output of buildTriangles(). `notes` is sorted ascending mod 12
// so renderers and walk-state matchers compare by canonical PC set (matches
// inboil's `triState` semantics). `rootPc` + `quality` are the identified
// triad for label rendering.
struct Triangle {
    std::array<Point2, 3> vertices;
    Point2 centroid;
    std::array<PitchClass, 3> notes;
    PitchClass rootPc;
    Quality quality;
};

// Pitch class at lattice vertex (row, col), centred so (rowCount/2, colCount/2)
// returns `centerPc`. Column step = +7 (perfect 5th); row step = +4 (major 3rd).
PitchClass pcAt(int row, int col, PitchClass centerPc,
                const LatticeGeometry& geo = kDefaultLatticeGeometry);

// 2-D vertex position. Parallelogram skew: each row offsets x by +triW/2.
Point2 vertexAt(int row, int col,
                const LatticeGeometry& geo = kDefaultLatticeGeometry);

float latticeWidth(const LatticeGeometry& geo = kDefaultLatticeGeometry);
float latticeHeight(const LatticeGeometry& geo = kDefaultLatticeGeometry);

// Builds 2 * (rowCount-1) * (colCount-1) triangles. Even index = upward
// (major); odd = downward (minor). Order: row-major, both per cell.
std::vector<Triangle> buildTriangles(
    PitchClass centerPc,
    const LatticeGeometry& geo = kDefaultLatticeGeometry);

// First triangle index (in `triangles`) whose interior or edge contains
// (x, y), or -1 if none.
int triangleAt(float x, float y, const std::vector<Triangle>& triangles);

// Display label for a triad, e.g. "C", "C#", "Cm". Returns one of 24 static
// const C strings; safe to keep a pointer to the result.
const char* labelFor(PitchClass rootPc, Quality quality);

// Builds a Triad from a sorted-PC array placed in the octave of `referenceMidi`,
// with each subsequent voice bumped +12 to enforce ascending order. Mirrors
// inboil's `oct = Math.floor(startChord[0] / 12)` placement used both for
// drag-path resolution and tap-to-set-startChord.
Triad rebuildTriadInOctave(std::array<PitchClass, 3> sortedPcs, MidiNote referenceMidi);

struct DragResolution {
    Triad newStartChord;
    std::vector<Transform> ops;
};

// Resolves a drag path (length >= 1, sorted-ascending PCs per element) to:
//   • newStartChord — `pathPcs[0]` placed in the octave of `referenceMidi`,
//     then bumped +12 per voice to enforce ascending order (mirrors inboil).
//   • ops — for each adjacent (i, i+1), the single P/L/R that produces
//     pathPcs[i+1] from the running chord. Pairs not reachable by a single
//     transform are silently skipped (compound ops deferred per ADR 008).
//
// Throws std::invalid_argument if pathPcs is empty.
DragResolution resolveDragPath(
    const std::vector<std::array<PitchClass, 3>>& pathPcs,
    MidiNote referenceMidi);

}  // namespace engine
}  // namespace oedipa
