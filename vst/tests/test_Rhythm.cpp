// Tests for the rhythm + ARP engine. Each predicate's expected output is
// the m4l reference verbatim — the m4l implementation is the spec, the
// shared test vectors enforce the JS↔C++ stream parity.

#include <catch2/catch_test_macros.hpp>

#include "Engine/Rhythm.h"
#include "Engine/Rng.h"

using namespace oedipa::engine;

TEST_CASE("gatingFires — All fires every sub-step", "[rhythm][all]")
{
    for (int i = 0; i < 32; ++i) CHECK(gatingFires(RhythmPreset::All, i));
}

TEST_CASE("gatingFires — Legato fires only at cell head", "[rhythm][legato]")
{
    CHECK(gatingFires(RhythmPreset::Legato, 0));
    for (int i = 1; i < 32; ++i) CHECK_FALSE(gatingFires(RhythmPreset::Legato, i));
}

TEST_CASE("gatingFires — Onbeat fires every quarter (idx % 4 == 0)", "[rhythm][onbeat]")
{
    CHECK(gatingFires(RhythmPreset::Onbeat, 0));
    CHECK_FALSE(gatingFires(RhythmPreset::Onbeat, 1));
    CHECK_FALSE(gatingFires(RhythmPreset::Onbeat, 2));
    CHECK_FALSE(gatingFires(RhythmPreset::Onbeat, 3));
    CHECK(gatingFires(RhythmPreset::Onbeat, 4));
    CHECK(gatingFires(RhythmPreset::Onbeat, 8));
    CHECK(gatingFires(RhythmPreset::Onbeat, 12));
}

TEST_CASE("gatingFires — Offbeat fires on the & of each quarter (idx % 4 == 2)", "[rhythm][offbeat]")
{
    CHECK_FALSE(gatingFires(RhythmPreset::Offbeat, 0));
    CHECK_FALSE(gatingFires(RhythmPreset::Offbeat, 1));
    CHECK(gatingFires(RhythmPreset::Offbeat, 2));
    CHECK_FALSE(gatingFires(RhythmPreset::Offbeat, 3));
    CHECK_FALSE(gatingFires(RhythmPreset::Offbeat, 4));
    CHECK(gatingFires(RhythmPreset::Offbeat, 6));
    CHECK(gatingFires(RhythmPreset::Offbeat, 10));
}

TEST_CASE("gatingFires — Syncopated mirrors the inboil pattern", "[rhythm][syncopated]")
{
    // Pattern: T F T F F T F T  (m4l/engine/tonnetz.ts:72)
    constexpr bool expected[] = { true, false, true, false, false, true, false, true };
    for (int i = 0; i < 16; ++i) {
        CHECK(gatingFires(RhythmPreset::Syncopated, i) == expected[i % 8]);
    }
}

TEST_CASE("gatingFires — Turing returns false (caller must use turingFires)", "[rhythm][turing]")
{
    // Turing is stateful — the static path returns false defensively so a
    // caller that forgot to branch sees silence rather than a wrong-shape
    // gate. The engine's processor branches on Turing before this call.
    for (int i = 0; i < 16; ++i) CHECK_FALSE(gatingFires(RhythmPreset::Turing, i));
}

TEST_CASE("fireIntervalSubsteps — interval per preset", "[rhythm][interval]")
{
    CHECK(fireIntervalSubsteps(RhythmPreset::Legato,     4) == 4);
    CHECK(fireIntervalSubsteps(RhythmPreset::Legato,     8) == 8);
    CHECK(fireIntervalSubsteps(RhythmPreset::All,        4) == 1);
    CHECK(fireIntervalSubsteps(RhythmPreset::Onbeat,     4) == 4);
    CHECK(fireIntervalSubsteps(RhythmPreset::Offbeat,    4) == 4);
    CHECK(fireIntervalSubsteps(RhythmPreset::Syncopated, 4) == 1);
    CHECK(fireIntervalSubsteps(RhythmPreset::Turing,     4) == 1);
}

TEST_CASE("turingFires — register evolves deterministically with seed", "[rhythm][turing][determinism]")
{
    // Two states with the same (length, seed) produce identical fire streams
    // — the contract tested in m4l/engine/tonnetz.test.ts.
    auto a = makeTuringState(8, 42u);
    auto b = makeTuringState(8, 42u);
    constexpr float lock = 0.7f;
    for (int i = 0; i < 64; ++i) {
        CHECK(turingFires(a, lock) == turingFires(b, lock));
    }
}

TEST_CASE("turingFires — different seeds diverge", "[rhythm][turing][seed]")
{
    auto a = makeTuringState(8, 1u);
    auto b = makeTuringState(8, 2u);
    int diffs = 0;
    for (int i = 0; i < 64; ++i) {
        if (turingFires(a, 0.5f) != turingFires(b, 0.5f)) ++diffs;
    }
    // With independent seeds the fire streams should overlap on most steps
    // but disagree on a meaningful fraction. ≥4 disagreements out of 64 is
    // a generous lower bound — anything substantially less suggests the
    // seed isn't actually reseeding the register.
    CHECK(diffs >= 4);
}

TEST_CASE("arpIndex — Off returns nullopt", "[arp][off]")
{
    Mulberry32 rng{0u};
    CHECK_FALSE(arpIndex(ArpMode::Off, 3, 0, rng).has_value());
}

TEST_CASE("arpIndex — Up cycles 0..N-1", "[arp][up]")
{
    Mulberry32 rng{0u};
    CHECK(arpIndex(ArpMode::Up, 3, 0, rng) == std::optional<int>{0});
    CHECK(arpIndex(ArpMode::Up, 3, 1, rng) == std::optional<int>{1});
    CHECK(arpIndex(ArpMode::Up, 3, 2, rng) == std::optional<int>{2});
    CHECK(arpIndex(ArpMode::Up, 3, 3, rng) == std::optional<int>{0});
    CHECK(arpIndex(ArpMode::Up, 3, 4, rng) == std::optional<int>{1});
}

TEST_CASE("arpIndex — Down cycles N-1..0", "[arp][down]")
{
    Mulberry32 rng{0u};
    CHECK(arpIndex(ArpMode::Down, 3, 0, rng) == std::optional<int>{2});
    CHECK(arpIndex(ArpMode::Down, 3, 1, rng) == std::optional<int>{1});
    CHECK(arpIndex(ArpMode::Down, 3, 2, rng) == std::optional<int>{0});
    CHECK(arpIndex(ArpMode::Down, 3, 3, rng) == std::optional<int>{2});
}

TEST_CASE("arpIndex — UpDown reflects without repeating endpoints", "[arp][updown]")
{
    Mulberry32 rng{0u};
    // chordSize=4, period = 2*(4-1) = 6 → 0,1,2,3,2,1, 0,1,2,3,2,1, ...
    constexpr int expected[12] = { 0, 1, 2, 3, 2, 1, 0, 1, 2, 3, 2, 1 };
    for (int i = 0; i < 12; ++i) {
        CHECK(arpIndex(ArpMode::UpDown, 4, i, rng) == std::optional<int>{expected[i]});
    }
}

TEST_CASE("arpIndex — Random stays in range and consumes the rng", "[arp][random]")
{
    Mulberry32 rng{42u};
    for (int i = 0; i < 32; ++i) {
        const auto idx = arpIndex(ArpMode::Random, 5, i, rng);
        REQUIRE(idx.has_value());
        CHECK(*idx >= 0);
        CHECK(*idx < 5);
    }
}

TEST_CASE("arpIndex — chordSize ≤ 1 returns 0 / nullopt edge cases", "[arp][edge]")
{
    Mulberry32 rng{0u};
    CHECK(arpIndex(ArpMode::Up,   1, 0, rng) == std::optional<int>{0});
    CHECK(arpIndex(ArpMode::Up,   1, 7, rng) == std::optional<int>{0});
    CHECK_FALSE(arpIndex(ArpMode::Up, 0, 0, rng).has_value());
}
