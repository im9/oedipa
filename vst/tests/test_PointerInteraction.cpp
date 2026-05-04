// PointerInteraction tests. Drives the state machine directly with
// (idx, time) inputs; no clock dependency.
//
// State transitions covered (per ADR 008 §"Interaction language"):
//   Idle → Tap (press, release without drift, before threshold)
//   Idle → Drag (press, enter another cell, release)
//   Idle → Anchor (press, no drift, tick crosses 400ms)
//   Anchor consumed once; subsequent ticks and release are silent.

#include <catch2/catch_test_macros.hpp>

#include "Engine/PointerInteraction.h"

#include <vector>

using namespace oedipa::engine;

TEST_CASE("Tap — press then quick release on same cell", "[pointer][tap]")
{
    PointerInteraction p;
    p.onPress(5, 0.0);
    REQUIRE(p.isPressed());

    auto out = p.onRelease();
    REQUIRE(out.has_value());
    CHECK(out->kind == PointerOutcome::Kind::Tap);
    CHECK(out->path == std::vector<int>{5});
    CHECK_FALSE(p.isPressed());
}

TEST_CASE("Drag — press, enter different cells, release", "[pointer][drag]")
{
    PointerInteraction p;
    p.onPress(5, 0.0);
    p.onEnter(7);
    p.onEnter(8);
    CHECK(p.currentPath() == std::vector<int>{5, 7, 8});

    auto out = p.onRelease();
    REQUIRE(out.has_value());
    CHECK(out->kind == PointerOutcome::Kind::Drag);
    CHECK(out->path == std::vector<int>{5, 7, 8});
    CHECK_FALSE(p.isPressed());
}

TEST_CASE("Drag — onEnter dedupes when index matches last", "[pointer][drag]")
{
    PointerInteraction p;
    p.onPress(5, 0.0);
    p.onEnter(5);  // same as initial — no-op, no drift
    CHECK(p.currentPath() == std::vector<int>{5});

    // Long-press should still be armed (no drift).
    auto t1 = p.onTick(500.0);
    REQUIRE(t1.has_value());
    CHECK(t1->kind == PointerOutcome::Kind::Anchor);
}

TEST_CASE("Drag — revisiting initial cell after drift is allowed", "[pointer][drag]")
{
    PointerInteraction p;
    p.onPress(5, 0.0);
    p.onEnter(7);
    p.onEnter(5);  // back to start — distinct from current tail (7), append
    CHECK(p.currentPath() == std::vector<int>{5, 7, 5});

    auto out = p.onRelease();
    REQUIRE(out.has_value());
    CHECK(out->kind == PointerOutcome::Kind::Drag);
    CHECK(out->path == std::vector<int>{5, 7, 5});
}

TEST_CASE("Anchor — long-press fires at threshold without drift", "[pointer][anchor]")
{
    PointerInteraction p;
    p.onPress(3, 100.0);

    SECTION("ticks before threshold are silent") {
        CHECK_FALSE(p.onTick(200.0).has_value());
        CHECK_FALSE(p.onTick(499.0).has_value());  // 100 + 399 = 499 < 100 + 400
    }
    SECTION("tick exactly at threshold fires Anchor") {
        auto out = p.onTick(500.0);  // 100 + 400 = 500
        REQUIRE(out.has_value());
        CHECK(out->kind == PointerOutcome::Kind::Anchor);
        CHECK(out->path == std::vector<int>{3});
    }
    SECTION("tick well past threshold also fires Anchor") {
        auto out = p.onTick(1000.0);
        REQUIRE(out.has_value());
        CHECK(out->kind == PointerOutcome::Kind::Anchor);
    }
}

TEST_CASE("Anchor — fires only once; subsequent ticks and release are silent", "[pointer][anchor]")
{
    PointerInteraction p;
    p.onPress(3, 0.0);

    auto fire = p.onTick(401.0);
    REQUIRE(fire.has_value());
    CHECK(fire->kind == PointerOutcome::Kind::Anchor);

    CHECK_FALSE(p.onTick(500.0).has_value());
    CHECK_FALSE(p.onTick(2000.0).has_value());

    // Release after Anchor returns nullopt — the press was "consumed" by
    // the long-press; no Tap should fire on the trailing pointerup.
    CHECK_FALSE(p.onRelease().has_value());
    CHECK_FALSE(p.isPressed());
}

TEST_CASE("Anchor — drift before threshold disarms long-press", "[pointer][anchor]")
{
    PointerInteraction p;
    p.onPress(3, 0.0);
    p.onEnter(4);

    CHECK_FALSE(p.onTick(401.0).has_value());
    CHECK_FALSE(p.onTick(10000.0).has_value());

    auto out = p.onRelease();
    REQUIRE(out.has_value());
    CHECK(out->kind == PointerOutcome::Kind::Drag);
}

TEST_CASE("cancel — abandons gesture without firing", "[pointer][cancel]")
{
    PointerInteraction p;
    p.onPress(5, 0.0);
    p.cancel();
    CHECK_FALSE(p.isPressed());
    CHECK_FALSE(p.onRelease().has_value());
    CHECK_FALSE(p.onTick(1000.0).has_value());
}

TEST_CASE("idle — release / tick with no press are silent", "[pointer][edge]")
{
    PointerInteraction p;
    CHECK_FALSE(p.onRelease().has_value());
    CHECK_FALSE(p.onTick(100.0).has_value());
}

TEST_CASE("re-press resets the gesture", "[pointer][edge]")
{
    PointerInteraction p;
    p.onPress(5, 0.0);
    p.onEnter(7);
    p.onPress(9, 100.0);  // new gesture, no intermediate release
    CHECK(p.currentPath() == std::vector<int>{9});

    // Long-press should arm fresh from the new press time (100 + 400 = 500).
    CHECK_FALSE(p.onTick(499.0).has_value());
    auto out = p.onTick(500.0);
    REQUIRE(out.has_value());
    CHECK(out->path == std::vector<int>{9});
}
