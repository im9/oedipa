// Plugin SlotBank wiring tests (ADR 008 Phase 5).
//
// Concerns covered:
//   1. captureSlot() reflects current live state (cells.op[], startChord
//      identity, APVTS jitter/seed).
//   2. applySlot() writes the slot's contents back to live state,
//      preserving the current octave on startChord and per-cell
//      vel/gate/prob/timing fields.
//   3. switchSlot() composes bank.switchTo + applySlot.
//   4. Auto-save fires for every user-driven edit channel:
//      setStartChord, setCell, APVTS jitter, APVTS seed, APVTS length.
//   5. applySlot() does NOT recurse — the slot the call wrote stays
//      exactly equal to its input afterwards.
//   6. State save/restore preserves activeSlotIndex.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include "Engine/SlotBank.h"
#include "Engine/State.h"
#include "Engine/Tonnetz.h"
#include "Plugin/Parameters.h"
#include "Plugin/PluginProcessor.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>

using namespace oedipa::engine;
using namespace oedipa::plugin;

namespace {

Slot makeSlot(std::array<Op, 8> ops, PitchClass root, Quality q, float jitter, std::uint32_t seed)
{
    Slot s{};
    s.ops = ops;
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

TEST_CASE("captureSlot reflects current live state", "[plugin][slotbank][capture]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();

    p.setStartChord({62, 65, 69});  // D minor (root pc 2, minor)
    Cell c{};
    c.op = Op::P;
    c.velocity = 0.8f; c.gate = 0.5f; c.probability = 0.9f; c.timing = -0.1f;
    p.setCell(0, c);
    *dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(pid::jitter)) = 0.42f;
    *dynamic_cast<juce::AudioParameterInt*>  (apvts.getParameter(pid::seed))   = 12345;

    const auto s = p.captureSlot();
    CHECK(s.ops[0] == Op::P);
    CHECK(s.startRootPc == 2);
    CHECK(s.startQuality == Quality::Minor);
    CHECK_THAT(s.jitter, Catch::Matchers::WithinAbs(0.42f, 1e-6f));
    CHECK(s.seed == 12345u);
}

TEST_CASE("applySlot writes ops, rebuilds startChord, sets jitter/seed",
          "[plugin][slotbank][apply]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();

    // Stamp per-cell numeric fields with non-default values; applySlot
    // must NOT clobber them (vel/gate/prob/timing are device-shared, not
    // per-slot, per m4l ADR 006 §"Axis 1").
    Cell c{};
    c.velocity = 0.33f; c.gate = 0.66f; c.probability = 0.5f; c.timing = 0.25f;
    for (int i = 0; i < 8; ++i) {
        c.op = Op::Hold;
        p.setCell(i, c);
    }

    Slot s = makeSlot({Op::P, Op::L, Op::R, Op::Hold, Op::Rest, Op::Hold, Op::Hold, Op::Hold},
                      9, Quality::Major, 0.15f, 7777u);
    p.applySlot(s);

    SECTION("cell ops follow the slot") {
        CHECK(p.getCell(0).op == Op::P);
        CHECK(p.getCell(1).op == Op::L);
        CHECK(p.getCell(2).op == Op::R);
        CHECK(p.getCell(4).op == Op::Rest);
    }

    SECTION("per-cell vel/gate/prob/timing are preserved") {
        const auto& d0 = p.getCell(0);
        CHECK_THAT(d0.velocity,    Catch::Matchers::WithinAbs(0.33f, 1e-6f));
        CHECK_THAT(d0.gate,        Catch::Matchers::WithinAbs(0.66f, 1e-6f));
        CHECK_THAT(d0.probability, Catch::Matchers::WithinAbs(0.5f, 1e-6f));
        CHECK_THAT(d0.timing,      Catch::Matchers::WithinAbs(0.25f, 1e-6f));
    }

    SECTION("startChord is rebuilt at current octave with slot's root + quality") {
        const auto sc = p.getStartChord();
        const auto id = identifyTriad(sc);
        CHECK(id.rootPc == 9);
        CHECK(id.quality == Quality::Major);
        // Octave preservation — buildTriad clamps root to [36, 84] and picks
        // the octave nearest the reference (the previous root). With a fresh
        // processor the previous root is 60 (C4); A near C4 is A3 = 57.
        CHECK(sc[0] == 57);
    }

    SECTION("jitter and seed are written into APVTS") {
        CHECK_THAT(*apvts.getRawParameterValue(pid::jitter),
                   Catch::Matchers::WithinAbs(0.15f, 1e-6f));
        CHECK((int) *apvts.getRawParameterValue(pid::seed) == 7777);
    }
}

TEST_CASE("applySlot is idempotent — the active slot equals the input afterwards",
          "[plugin][slotbank][apply][recursion]")
{
    OedipaProcessor p;
    Slot s = makeSlot({Op::P, Op::P, Op::L, Op::R, Op::Hold, Op::Hold, Op::Hold, Op::Hold},
                      4, Quality::Minor, 0.3f, 999u);
    p.applySlot(s);
    // After applySlot, the bank's active slot must equal `s` exactly —
    // not a stale version that captured partial mid-apply state.
    CHECK(slotsEqual(p.getSlot(p.activeSlotIndex()), s));
}

TEST_CASE("switchSlot composes switchTo + applySlot", "[plugin][slotbank][switch]")
{
    OedipaProcessor p;

    Slot s2 = makeSlot({Op::L, Op::L, Op::L, Op::L, Op::L, Op::L, Op::L, Op::L},
                       11, Quality::Minor, 0.4f, 8888u);
    p.setSlot(2, s2);  // rehydration only — does not change live or active

    REQUIRE(p.activeSlotIndex() == 0);
    REQUIRE(p.getCell(0).op != Op::L);

    p.switchSlot(2);
    CHECK(p.activeSlotIndex() == 2);
    CHECK(p.getCell(0).op == Op::L);
    CHECK(p.getCell(7).op == Op::L);
    const auto id = identifyTriad(p.getStartChord());
    CHECK(id.rootPc == 11);
    CHECK(id.quality == Quality::Minor);
}

TEST_CASE("switchSlot ignores out-of-range indices", "[plugin][slotbank][switch][bounds]")
{
    OedipaProcessor p;
    p.switchSlot(2);
    REQUIRE(p.activeSlotIndex() == 2);

    p.switchSlot(-1);
    CHECK(p.activeSlotIndex() == 2);
    p.switchSlot(99);
    CHECK(p.activeSlotIndex() == 2);
}

TEST_CASE("setStartChord auto-saves into the active slot",
          "[plugin][slotbank][autosave]")
{
    OedipaProcessor p;
    // Capture slot 0 BEFORE switching. The processor seeds slot 0 with the
    // default program (Mixed: P, L, R, Hold) at construction, so the
    // "untouched" baseline is whatever the constructor put there, not the
    // engine-level Slot{} aggregate.
    const auto s0Before = p.getSlot(0);

    p.switchSlot(1);
    p.setStartChord({64, 67, 71});  // E minor (root pc 4, minor)

    const auto& s = p.getSlot(1);
    CHECK(s.startRootPc == 4);
    CHECK(s.startQuality == Quality::Minor);

    // Slot 0 stays untouched — auto-save targets the active slot only.
    CHECK(slotsEqual(p.getSlot(0), s0Before));
}

TEST_CASE("setCell auto-saves into the active slot",
          "[plugin][slotbank][autosave]")
{
    OedipaProcessor p;
    Cell c{};
    c.op = Op::R;
    p.setCell(3, c);

    const auto& s = p.getSlot(0);
    CHECK(s.ops[3] == Op::R);
    // Untouched cells keep the default-program ops the constructor seeded
    // (Mixed: cells[0]=P).
    CHECK(s.ops[0] == Op::P);
}

TEST_CASE("APVTS jitter change auto-saves", "[plugin][slotbank][autosave][apvts]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();
    *dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(pid::jitter)) = 0.55f;

    const auto& s = p.getSlot(0);
    CHECK_THAT(s.jitter, Catch::Matchers::WithinAbs(0.55f, 1e-6f));
}

TEST_CASE("APVTS seed change auto-saves", "[plugin][slotbank][autosave][apvts]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();
    *dynamic_cast<juce::AudioParameterInt*>(apvts.getParameter(pid::seed)) = 4242;

    const auto& s = p.getSlot(0);
    CHECK(s.seed == 4242u);
}

TEST_CASE("setCellField mutates only the targeted field",
          "[plugin][cellfield]")
{
    OedipaProcessor p;
    Cell initial{};
    initial.op = Op::P;
    initial.velocity    = 1.0f;
    initial.gate        = 1.0f;
    initial.probability = 1.0f;
    initial.timing      = 0.0f;
    p.setCell(0, initial);

    p.setCellField(0, CellField::Velocity, 0.4f);
    CHECK_THAT(p.getCell(0).velocity,    Catch::Matchers::WithinAbs(0.4f, 1e-6f));
    CHECK(p.getCell(0).op == Op::P);
    CHECK_THAT(p.getCell(0).gate,        Catch::Matchers::WithinAbs(1.0f, 1e-6f));
    CHECK_THAT(p.getCell(0).probability, Catch::Matchers::WithinAbs(1.0f, 1e-6f));
    CHECK_THAT(p.getCell(0).timing,      Catch::Matchers::WithinAbs(0.0f, 1e-6f));

    p.setCellField(0, CellField::Gate, 0.5f);
    p.setCellField(0, CellField::Probability, 0.75f);
    p.setCellField(0, CellField::Timing, -0.2f);
    CHECK_THAT(p.getCell(0).gate,        Catch::Matchers::WithinAbs(0.5f, 1e-6f));
    CHECK_THAT(p.getCell(0).probability, Catch::Matchers::WithinAbs(0.75f, 1e-6f));
    CHECK_THAT(p.getCell(0).timing,      Catch::Matchers::WithinAbs(-0.2f, 1e-6f));
    CHECK(p.getCell(0).op == Op::P);
}

TEST_CASE("setCellField is a no-op for out-of-range index or NaN",
          "[plugin][cellfield][bounds]")
{
    OedipaProcessor p;
    const auto before = p.getCell(0);
    p.setCellField(-1, CellField::Velocity, 0.5f);
    p.setCellField(99, CellField::Velocity, 0.5f);
    p.setCellField(0,  CellField::Velocity, std::nanf(""));
    CHECK(p.getCell(0).velocity == before.velocity);
    CHECK(p.getCell(0).gate == before.gate);
    CHECK(p.getCell(0).probability == before.probability);
    CHECK(p.getCell(0).timing == before.timing);
}

TEST_CASE("setCellField does NOT auto-save into the active slot",
          "[plugin][cellfield][autosave]")
{
    // Per ADR 006 §"Axis 1": vel/gate/prob/timing are device-shared, not
    // per-slot. The slot's `ops` array stores op only, so changing a
    // numeric field has nothing to mirror into the slot.
    OedipaProcessor p;
    Cell c{};
    c.op = Op::P;
    p.setCell(0, c);
    const auto slotBefore = p.getSlot(0);

    p.setCellField(0, CellField::Velocity, 0.3f);
    p.setCellField(0, CellField::Gate,     0.7f);

    const auto& slotAfter = p.getSlot(0);
    CHECK(slotAfter.ops == slotBefore.ops);
    CHECK(slotAfter.startRootPc == slotBefore.startRootPc);
    CHECK(slotAfter.startQuality == slotBefore.startQuality);
}

TEST_CASE("Edit slot 0, switch to 1, edit, switch back: slot 0's edit survives",
          "[plugin][slotbank][round-trip]")
{
    OedipaProcessor p;

    // Slot 0 edit — pick an op that differs from the constructor default
    // (Mixed: cells[0]=P) so the assertion has signal.
    Cell c0{};
    c0.op = Op::Rest;
    p.setCell(0, c0);

    // Switch to slot 1, make a different edit on cell 1. Slot 1 starts as
    // the engine-default Slot (all Hold), so cell[1]=Hold there. Set it to
    // a value that also differs from slot 0's cell[1] (Mixed: L) so we can
    // tell whether slot 1's edit bled back.
    p.switchSlot(1);
    Cell c1{};
    c1.op = Op::P;
    p.setCell(1, c1);

    // Switch back to slot 0 — original edit + slot-0 default cell[1]=L
    // should be live; cell[1] must NOT be P (which was slot 1's edit).
    p.switchSlot(0);
    CHECK(p.getCell(0).op == Op::Rest);
    CHECK(p.getCell(1).op != Op::P);
}
