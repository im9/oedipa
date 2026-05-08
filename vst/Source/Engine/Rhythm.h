// Rhythm + ARP engine — port of m4l/engine/tonnetz.ts (RhythmPreset / ArpMode
// section). Stateless predicates (gatingFires) for the static presets;
// stateful turing register for the stochastic preset; index picker for ARP.
//
// Deliberately mirrors the m4l semantics 1:1 — m4l is the reference
// implementation tested against inboil. Any divergence is a porting bug.

#pragma once

#include "Engine/Rng.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace oedipa {
namespace engine {

enum class RhythmPreset { All, Legato, Onbeat, Offbeat, Syncopated, Turing };
enum class ArpMode      { Off, Up, Down, UpDown, Random };

// Within-cell tick gating for the static presets. `subStepIdx` is a
// sub-step index inside the current cell (head = 0). Pure: no PRNG, no
// state. `Turing` is intentionally excluded — its gating is stateful and
// goes through `turingFires` against a register state.
//
// `offbeat` uses the standard musical "& of each quarter" definition
// (idx % 4 == 2), matching m4l's spec-corrected port from inboil's literal
// `idx % 2 == 1`.
bool gatingFires(RhythmPreset mode, int subStepIdx);

// Sub-steps between fires for the given preset. Drives gate-end scheduling
// so `gate=1.0` always means "until the next fire" regardless of preset.
// `legato` spans the whole cell; the dense / variable-gap presets fall
// back to 1 so a sub-1.0 gate releases by the next 16th boundary and
// never overlaps a denser fire downstream.
int fireIntervalSubsteps(RhythmPreset mode, int stepsPerTransform);

// Turing-machine rhythm state. Register holds 0/1 bits, `register[0]` is
// the newest. PRNG draws determine register init + per-step bit flips.
// Caller owns the state; lifetime spans transport runs and resets on
// transport restart (matches `arpRng`'s reset semantics).
struct TuringRhythmState
{
    std::vector<int> reg;
    Mulberry32 rng;
};

// Construct a turing register of `length` bits seeded by `seed`.
// `length` is clamped to [2, 32]; `seed` is consumed by mulberry32 (the
// same PRNG used by the walker, so the stochastic stream is seed-coherent
// across rhythm + arp + walker).
TuringRhythmState makeTuringState(int length, std::uint32_t seed);

// Compute fires-this-step bool, then advance the register one tick.
// `lock` ∈ [0, 1]: 1.0 = frozen loop (lastBit carries over), 0.0 = fully
// random (lastBit flipped before reinsertion). Mutates `state` (advances
// register + draws from rng).
bool turingFires(TuringRhythmState& state, float lock);

// ARP picker. Returns the index into the voiced chord array to play at
// this fire, or `std::nullopt` for `Off` / empty chord (caller emits the
// full voiced chord). `fireIdx` is the count of ARP-active fires since
// the cell head (caller resets at every cell boundary, EXCEPT under
// legato + arp where the cycle spans cells — see m4l host.ts:577-585).
// `rng` only ticks when `mode == Random`; for the deterministic modes
// it is not consulted.
std::optional<int> arpIndex(ArpMode mode, int chordSize, int fireIdx, Mulberry32& rng);

}  // namespace engine
}  // namespace oedipa
