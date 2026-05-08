// SlotBank: 4-slot snapshot store for the program (per ADR 008 §"Phase 5",
// porting m4l ADR 006 §"Axis 1").
//
// Storage only. Applying a slot to the live processor state — and the
// MIDI-deferred startChord handoff (m4l host's `pendingSlotStartChord`) —
// live on the processor at wiring time, not on this object.
//
// JUCE-free; shared with the future iOS UI.

#pragma once

#include "Engine/State.h"

#include <array>
#include <cstddef>

namespace oedipa {
namespace engine {

constexpr int kSlotCount = 4;

class SlotBank {
public:
    int activeIndex() const { return active_; }
    const Slot& slotAt(int idx) const { return slots_.at(static_cast<std::size_t>(idx)); }
    const Slot& activeSlot() const { return slotAt(active_); }

    // Rehydrate a slot from persistence. Out-of-range index is a silent
    // no-op (matches m4l host.setSlot bounds behavior).
    void setSlot(int idx, const Slot& s);

    // Switch the active slot. Out-of-range index is a no-op. Caller is
    // responsible for applying the new slot's contents to live state.
    void switchTo(int idx);

    // Auto-save: write `live` into the currently-active slot. Equivalent
    // to setSlot(activeIndex(), live).
    void syncActive(const Slot& live) { setSlot(active_, live); }

private:
    std::array<Slot, kSlotCount> slots_{};
    int active_ = 0;
};

}  // namespace engine
}  // namespace oedipa
