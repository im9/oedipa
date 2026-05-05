// SequenceDrawer: tracks which sequence cell the user is currently
// editing in the inline drawer below the SEQ row (per ADR 008 §"Phase 5").
//
// The drawer is index-only — the per-cell parameter values themselves
// (`velocity / gate / probability / timing` and the `Op` itself) live on
// the processor's `Cell` store. This object answers a single question:
// "is the drawer open, and if so on which cell?"
//
// Toggle semantics mirror inboil's editor-sheet affordance: clicking the
// same pill again dismisses; clicking a different pill switches without
// a close-then-open animation. Sequence shrinks auto-close when they
// invalidate the selection.
//
// JUCE-free; shared with the future iOS UI.

#pragma once

namespace oedipa {
namespace engine {

class SequenceDrawer {
public:
    int selectedCell() const { return selected_; }
    bool isOpen() const { return selected_ >= 0; }

    // Click on a SEQ pill. If the drawer is already open on `cellIdx`,
    // closes it; otherwise opens (or switches) to that cell.
    void toggle(int cellIdx);

    // Explicit dismiss (ESC, click outside, slot switch). Idempotent.
    void close() { selected_ = -1; }

    // Called when the sequence length changes (cells added or removed).
    // If the selected cell index is no longer a valid index in the new
    // sequence, closes the drawer.
    void onSequenceLengthChanged(int newLength);

private:
    int selected_ = -1;
};

}  // namespace engine
}  // namespace oedipa
