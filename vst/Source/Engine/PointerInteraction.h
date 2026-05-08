// Pointer interaction state machine: tap / drag / long-press over an
// indexed cell grid (lattice triangles, but the type is grid-agnostic).
//
// Design (per ADR 008 §"Interaction language"):
//   • onPress(idx, t)         — start a press on cell `idx` at time t (ms)
//   • onEnter(idx)            — cursor crossed into a different cell;
//                               appended to the path (de-duped against last)
//   • onTick(t)               — driven by the editor's UI timer; if the
//                               cursor is still on the initial cell at
//                               t >= press + kLongPressMs, fires Anchor
//   • onRelease()             — terminates the gesture; returns Tap
//                               (no drift, no anchor) or Drag (drifted)
//   • cancel()                — abandon the gesture without firing
//
// Shared with future iOS UI (touch produces the same press/enter/release
// stream). No JUCE / no platform clock — the host injects `nowMs`, which
// also makes the long-press timing trivially testable.

#pragma once

#include <optional>
#include <vector>

namespace oedipa {
namespace engine {

struct PointerOutcome {
    enum class Kind { Tap, Drag, Anchor };
    Kind kind;
    // Tap / Anchor: length 1 (the cell at outcome). Drag: length >= 2.
    std::vector<int> path;
};

class PointerInteraction {
public:
    // Long-press threshold ported from inboil (`LONG_PRESS_MS = 400`).
    static constexpr double kLongPressMs = 400.0;

    void onPress(int triIdx, double nowMs);

    // Cursor moved to a new cell. No-op if `triIdx == path.back()` (defends
    // against duplicate hit-test dispatches). The first onEnter with a
    // distinct index marks the gesture as "drifted" and disarms the
    // long-press: no Anchor will fire on subsequent ticks.
    void onEnter(int triIdx);

    // Drives the long-press timer. Returns Anchor exactly once when the
    // threshold is crossed without drift; subsequent ticks return nullopt.
    std::optional<PointerOutcome> onTick(double nowMs);

    // Terminates the gesture. Returns:
    //   • nullopt   — no press was active, or Anchor already fired
    //   • Tap       — pressed but never drifted
    //   • Drag      — at least one onEnter to a different cell
    std::optional<PointerOutcome> onRelease();

    // Abort without firing (used when the lattice loses focus / scroll
    // takes over / window deactivates).
    void cancel();

    bool isPressed() const { return phase_ != Phase::Idle; }
    const std::vector<int>& currentPath() const { return path_; }

private:
    enum class Phase { Idle, Pressed, Anchored };
    Phase phase_ = Phase::Idle;
    std::vector<int> path_;
    double pressedAtMs_ = 0.0;
    bool drifted_ = false;
};

}  // namespace engine
}  // namespace oedipa
