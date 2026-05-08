// SlotBank tests.
//
// Models the 4-slot snapshot bank from m4l ADR 006 §"Axis 1", but pared
// down to the storage semantics only — applying a slot to live state and
// the MIDI-driven `pendingSlotStartChord` deferral live on the
// processor (Phase 5 wiring), not on this object.
//
// Behaviors covered:
//   • Constructs with 4 default slots and active = 0.
//   • setSlot(idx, s) — rehydration, stores without changing active.
//   • switchTo(idx) — updates activeIndex; out-of-range is a no-op.
//   • syncActive(live) — auto-save: writes `live` into the active slot
//     and ONLY the active slot.
//   • Reading slotAt(idx) does not aggregate any live state — pure store.

#include <catch2/catch_test_macros.hpp>

#include "Engine/SlotBank.h"

using namespace oedipa::engine;

namespace {

Slot makeSlot(Op op, PitchClass root, Quality q, float jitter, std::uint32_t seed)
{
    Slot s{};
    s.ops.fill(op);
    s.startRootPc = root;
    s.startQuality = q;
    s.jitter = jitter;
    s.seed = seed;
    return s;
}

bool slotsEqual(const Slot& a, const Slot& b)
{
    if (a.ops != b.ops) return false;
    if (a.startRootPc != b.startRootPc) return false;
    if (a.startQuality != b.startQuality) return false;
    if (a.jitter != b.jitter) return false;
    if (a.seed != b.seed) return false;
    return true;
}

}  // namespace

TEST_CASE("Bank starts with 4 default slots and active = 0", "[slotbank][initial]")
{
    SlotBank bank;
    CHECK(bank.activeIndex() == 0);
    Slot defaults{};
    for (int i = 0; i < kSlotCount; ++i) {
        CHECK(slotsEqual(bank.slotAt(i), defaults));
    }
}

TEST_CASE("activeSlot() reflects the active index", "[slotbank][active]")
{
    SlotBank bank;
    Slot s = makeSlot(Op::P, 7, Quality::Minor, 0.5f, 12345u);
    bank.setSlot(2, s);
    CHECK(bank.activeIndex() == 0);  // setSlot does not change active

    bank.switchTo(2);
    CHECK(bank.activeIndex() == 2);
    CHECK(slotsEqual(bank.activeSlot(), s));
}

TEST_CASE("setSlot stores without touching active or other slots", "[slotbank][setSlot]")
{
    SlotBank bank;
    Slot s = makeSlot(Op::L, 4, Quality::Major, 0.25f, 99u);
    bank.setSlot(3, s);

    CHECK(bank.activeIndex() == 0);
    CHECK(slotsEqual(bank.slotAt(3), s));

    Slot defaults{};
    CHECK(slotsEqual(bank.slotAt(0), defaults));
    CHECK(slotsEqual(bank.slotAt(1), defaults));
    CHECK(slotsEqual(bank.slotAt(2), defaults));
}

TEST_CASE("setSlot ignores out-of-range indices", "[slotbank][setSlot][bounds]")
{
    SlotBank bank;
    Slot s = makeSlot(Op::R, 1, Quality::Minor, 0.1f, 7u);
    bank.setSlot(-1, s);
    bank.setSlot(kSlotCount, s);
    bank.setSlot(99, s);

    Slot defaults{};
    for (int i = 0; i < kSlotCount; ++i) {
        CHECK(slotsEqual(bank.slotAt(i), defaults));
    }
}

TEST_CASE("switchTo updates active for valid indices", "[slotbank][switchTo]")
{
    SlotBank bank;
    bank.switchTo(2);
    CHECK(bank.activeIndex() == 2);
    bank.switchTo(0);
    CHECK(bank.activeIndex() == 0);
    bank.switchTo(3);
    CHECK(bank.activeIndex() == 3);
}

TEST_CASE("switchTo on out-of-range index is a no-op", "[slotbank][switchTo][bounds]")
{
    SlotBank bank;
    bank.switchTo(2);
    REQUIRE(bank.activeIndex() == 2);

    bank.switchTo(-1);
    CHECK(bank.activeIndex() == 2);
    bank.switchTo(kSlotCount);
    CHECK(bank.activeIndex() == 2);
    bank.switchTo(99);
    CHECK(bank.activeIndex() == 2);
}

TEST_CASE("syncActive writes into the active slot only", "[slotbank][syncActive]")
{
    SlotBank bank;
    bank.switchTo(2);
    Slot live = makeSlot(Op::P, 9, Quality::Minor, 0.7f, 42u);
    bank.syncActive(live);

    CHECK(slotsEqual(bank.slotAt(2), live));

    Slot defaults{};
    CHECK(slotsEqual(bank.slotAt(0), defaults));
    CHECK(slotsEqual(bank.slotAt(1), defaults));
    CHECK(slotsEqual(bank.slotAt(3), defaults));
}

TEST_CASE("syncActive follows switchTo (active changes → target changes)",
          "[slotbank][syncActive][switchTo]")
{
    SlotBank bank;
    Slot a = makeSlot(Op::P, 0, Quality::Major, 0.1f, 1u);
    Slot b = makeSlot(Op::L, 7, Quality::Minor, 0.9f, 2u);

    bank.syncActive(a);  // writes to slot 0 (default active)
    CHECK(slotsEqual(bank.slotAt(0), a));

    bank.switchTo(3);
    bank.syncActive(b);  // now writes to slot 3
    CHECK(slotsEqual(bank.slotAt(3), b));
    CHECK(slotsEqual(bank.slotAt(0), a));  // slot 0 unchanged
}

TEST_CASE("Round-trip: setSlot → switchTo → activeSlot returns what was stored",
          "[slotbank][round-trip]")
{
    SlotBank bank;
    Slot s = makeSlot(Op::R, 5, Quality::Major, 0.333f, 0xDEADBEEFu);
    bank.setSlot(1, s);
    bank.switchTo(1);
    CHECK(slotsEqual(bank.activeSlot(), s));
}
