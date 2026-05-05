#include "Engine/SlotBank.h"

namespace oedipa {
namespace engine {

void SlotBank::setSlot(int idx, const Slot& s)
{
    if (idx < 0 || idx >= kSlotCount) return;
    slots_[static_cast<std::size_t>(idx)] = s;
}

void SlotBank::switchTo(int idx)
{
    if (idx < 0 || idx >= kSlotCount) return;
    active_ = idx;
}

}  // namespace engine
}  // namespace oedipa
