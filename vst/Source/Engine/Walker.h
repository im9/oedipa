// Tonnetz walker — pure C++17 cell-sequencer walk + anchor handling.
//
// Surface mirrors m4l/engine/tonnetz.ts (`walk`, `walkStepEvent`) so the
// shared cross-target test vectors in docs/ai/tonnetz-test-vectors.json
// (`walk_deterministic`, `walk_step_events`, `walk_jitter`) apply
// unchanged. Adds anchor support per ADR 001 §"Sequencer state" (the
// vst-only extension — m4l has no anchors).
//
// ADR 008 boundary: this header (and Walker.cpp) MUST NOT include any
// <juce_*> header. Walker is part of the Engine/ iOS-reuse layer; a
// JUCE include below this line is a review blocker.

#pragma once

#include "State.h"
#include "Tonnetz.h"

#include <cstdint>
#include <optional>
#include <vector>

namespace oedipa {
namespace engine {

enum class StepDirection { Forward, Reverse, Pingpong, Random };

// Walk inputs. `cells` is the active program (length 1..N). `anchors` is a
// sorted-by-step list of pinned chord overrides; an anchor at step S sets
// the cursor to (rootPc, quality) rebuilt near the prior cursor's root and
// resets the transform counter so the next boundary consumes cells[0].
struct WalkState {
    Triad startChord{60, 64, 67};
    std::vector<Cell> cells;
    int stepsPerTransform = 1;
    float jitter = 0.0f;
    std::uint32_t seed = 0;
    StepDirection stepDirection = StepDirection::Forward;
    std::vector<Anchor> anchors;
};

// Per-step boundary outcome. `cellIdx == -1` is the sentinel for an
// anchor fire (no cell was consumed). `played` is false for rest, hold,
// and probability-fail boundaries; the host uses it to decide whether to
// emit a fresh attack. The three `humanize*` floats are uniform [0, 1)
// raw draws — host applies preset amount + signed-noise math (ADR 005).
struct StepEvent {
    int cellIdx;
    Op resolvedOp;
    Triad chord;
    bool played;
    float humanizeVel;
    float humanizeGate;
    float humanizeTiming;
};

// Returns the chord cursor at sub-step `pos`. Reseeds PRNG from
// `state.seed` on every call so transport scrubbing / resume-from-arbitrary-
// position is deterministic ("any-pos restart consistency" in walk_jitter).
Triad walk(const WalkState& state, int pos);

// Returns the boundary event at sub-step `pos`, or std::nullopt when:
//   - pos <= 0 (no boundary at the start)
//   - pos % stepsPerTransform != 0 (not a transform boundary)
//   - cells is empty
// Anchor steps that coincide with a transform boundary fire as anchor
// events (cellIdx = -1, resolvedOp = Hold, played = true).
std::optional<StepEvent> walkStepEvent(const WalkState& state, int pos);

}  // namespace engine
}  // namespace oedipa
