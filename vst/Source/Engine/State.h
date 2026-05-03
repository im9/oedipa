// Plugin-shared data types: cells, slots, anchors. Pure C++17, no JUCE.
//
// ADR 008 boundary: this header lives under Source/Engine/ so it stays
// usable from the future iOS app target (SwiftUI rendering against the
// same data). A juce include below this line is a review blocker.
//
// These types are storage-shaped. They mirror the m4l per-cell shape
// (ADR 005) and slot bank (ADR 006), with one intentional divergence
// noted in ADR 008: chord quality is a typed enum (`'triad' | '7th'`),
// not a boolean — but quality lives on the processor as a parameter,
// not on these structs. The `Quality` here is the slot's start-chord
// major/minor flag (engine::Quality, reused).

#pragma once

#include "Tonnetz.h"

#include <array>
#include <cstdint>
#include <vector>

namespace oedipa {
namespace engine {

// Op for a single sequencer cell. Mirrors m4l's per-cell `Op` type.
//   P / L / R — Tonnetz transforms
//   Hold      — repeat previous chord (no transform)
//   Rest      — silent step (ADR 005)
enum class Op { P, L, R, Hold, Rest };

// Per-cell numeric expression (ADR 005). All four are 0..1 except `timing`
// which is signed (-1..+1, fraction of a transform interval). Defaults =
// "neutral": full velocity, full gate, always fires, on the grid.
struct Cell {
    Op op = Op::Hold;
    float velocity = 1.0f;
    float gate = 1.0f;
    float probability = 1.0f;
    float timing = 0.0f;
};

// Slot bank entry (ADR 006 §"Axis 1"). Stores the program: cell-op pattern,
// start chord (root + quality only — register is anchored at load time),
// jitter, and seed. Per-cell numeric expression (vel/gate/prob/timing) is
// device-shared, NOT per-slot — switching slots leaves it untouched.
//
// Phase 2 stores 8 ops always; the active length comes from the processor's
// `length` parameter. Phase 5 will refine slot/length interaction.
struct Slot {
    std::array<Op, 8> ops{Op::Hold, Op::Hold, Op::Hold, Op::Hold,
                          Op::Hold, Op::Hold, Op::Hold, Op::Hold};
    PitchClass startRootPc = 0;        // C
    Quality startQuality = Quality::Major;
    float jitter = 0.0f;
    std::uint32_t seed = 0;
};

// Anchor: a pinned step → chord mapping on the lattice (ADR 008 §lattice).
// Long-press on a cell creates an anchor at the next anchor step. Phase 2
// defines the schema and round-trips an empty list; Phase 4 wires the
// interaction.
struct Anchor {
    int step = 0;                    // sub-step index (>=0)
    PitchClass rootPc = 0;
    Quality quality = Quality::Major;
};

}  // namespace engine
}  // namespace oedipa
