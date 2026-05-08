// Lattice geometry + drag-path resolver tests. Covers the engine surface
// added in ADR 008 Phase 4a (geometry math, triangle build, hit-test,
// drag-to-sequence). Renderer-side behavior is exercised manually in the
// host (per CLAUDE.md "GUI / UI components") — this file owns the logic
// layer in isolation.
//
// Constants used in expectations (geometry, pcAt formula) match
// inboil's `TonnetzSheet.svelte` reference; ADR 008 §UI mandates parity.

#include <catch2/catch_test_macros.hpp>

#include "Engine/Lattice.h"
#include "Engine/Tonnetz.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

using namespace oedipa::engine;

namespace {

// Approximate-equal for floats with explicit tolerance. Geometry math is
// exact in float for these magnitudes; tolerance covers FP drift on /3 etc.
constexpr float kEps = 1e-4f;

bool nearlyEqual(float a, float b, float eps = kEps)
{
    return std::abs(a - b) < eps;
}

}  // namespace

TEST_CASE("pcAt — center returns centerPc; +7 col-step, +4 row-step", "[lattice][geometry]")
{
    // Default geometry: rowCount=5, colCount=7 → cr=2, cc=3.
    SECTION("center cell == centerPc, for any centerPc") {
        for (int center = 0; center < 12; ++center) {
            CHECK(pcAt(2, 3, center) == center);
        }
    }
    SECTION("column step is +7 mod 12 (perfect 5th)") {
        CHECK(pcAt(2, 4, 0) == 7);
        CHECK(pcAt(2, 5, 0) == 2);   // 14 mod 12
        CHECK(pcAt(2, 2, 0) == 5);   // -7 mod 12
    }
    SECTION("row step is +4 mod 12 (major 3rd)") {
        CHECK(pcAt(3, 3, 0) == 4);
        CHECK(pcAt(4, 3, 0) == 8);
        CHECK(pcAt(1, 3, 0) == 8);   // -4 mod 12
    }
    SECTION("corner cells, centerPc=0") {
        CHECK(pcAt(0, 0, 0) == 7);   // (0 + (-3)*7 + (-2)*4) mod 12 = -29 mod 12 = 7
        CHECK(pcAt(4, 6, 0) == 5);   // (0 + 3*7 + 2*4) mod 12 = 29 mod 12 = 5
    }
}

TEST_CASE("vertexAt — parallelogram skew matches inboil constants", "[lattice][geometry]")
{
    SECTION("origin at (pad, pad)") {
        const auto v = vertexAt(0, 0);
        CHECK(nearlyEqual(v.x, 40.0f));
        CHECK(nearlyEqual(v.y, 40.0f));
    }
    SECTION("col step = triW (no skew on row 0)") {
        const auto v = vertexAt(0, 1);
        CHECK(nearlyEqual(v.x, 120.0f));
        CHECK(nearlyEqual(v.y, 40.0f));
    }
    SECTION("row step = triH; row also offsets x by +triW/2") {
        const auto v = vertexAt(1, 0);
        CHECK(nearlyEqual(v.x, 80.0f));   // 40 + 0*80 + 1*40
        CHECK(nearlyEqual(v.y, 110.0f));  // 40 + 1*70
    }
    SECTION("far corner (4, 6)") {
        const auto v = vertexAt(4, 6);
        CHECK(nearlyEqual(v.x, 680.0f));  // 40 + 6*80 + 4*40
        CHECK(nearlyEqual(v.y, 320.0f));  // 40 + 4*70
    }
}

TEST_CASE("latticeWidth / latticeHeight — bounding box constants", "[lattice][geometry]")
{
    // Width = pad*2 + (cols-1)*triW + (rows-1)*triW/2 = 80 + 480 + 160 = 720
    CHECK(nearlyEqual(latticeWidth(), 720.0f));
    // Height = pad*2 + (rows-1)*triH = 80 + 280 = 360
    CHECK(nearlyEqual(latticeHeight(), 360.0f));
}

TEST_CASE("buildTriangles — 48 cells, even=major, odd=minor", "[lattice][build]")
{
    const auto tris = buildTriangles(0);

    SECTION("count = 2 * (rowCount-1) * (colCount-1)") {
        REQUIRE(tris.size() == 48);
    }

    SECTION("every even index is upward / Major; every odd is downward / Minor") {
        for (size_t i = 0; i < tris.size(); ++i) {
            const auto expected = (i % 2 == 0) ? Quality::Major : Quality::Minor;
            CHECK(tris[i].quality == expected);
        }
    }

    SECTION("notes are sorted ascending mod 12") {
        for (const auto& t : tris) {
            CHECK(t.notes[0] <= t.notes[1]);
            CHECK(t.notes[1] <= t.notes[2]);
            for (auto pc : t.notes) {
                CHECK(pc >= 0);
                CHECK(pc < 12);
            }
        }
    }
}

TEST_CASE("buildTriangles — first triangle at (0,0) is G major (centerPc=0)", "[lattice][build]")
{
    // pcAt with centerPc=0: (0,0)=7, (0,1)=2, (1,0)=11 → sorted (2,7,11).
    // identifyTriad on these PCs picks root=7, quality=Major (G major).
    const auto tris = buildTriangles(0);
    REQUIRE(tris.size() >= 2);

    const auto& t0 = tris[0];
    CHECK(t0.notes == std::array<PitchClass, 3>{2, 7, 11});
    CHECK(t0.rootPc == 7);
    CHECK(t0.quality == Quality::Major);

    // Vertices match vertexAt for (0,0), (0,1), (1,0).
    CHECK(nearlyEqual(t0.vertices[0].x, 40.0f));
    CHECK(nearlyEqual(t0.vertices[0].y, 40.0f));
    CHECK(nearlyEqual(t0.vertices[1].x, 120.0f));
    CHECK(nearlyEqual(t0.vertices[2].x, 80.0f));
    CHECK(nearlyEqual(t0.vertices[2].y, 110.0f));

    // Centroid = mean of vertices.
    CHECK(nearlyEqual(t0.centroid.x, 80.0f));
    CHECK(nearlyEqual(t0.centroid.y, (40.0f + 40.0f + 110.0f) / 3.0f));
}

TEST_CASE("buildTriangles — second triangle is B minor (paired downward)", "[lattice][build]")
{
    // (1,0)=11, (1,1)=6, (0,1)=2 → sorted (2,6,11). Root pc that gives
    // {0,3,7} interval set: pc=11 → {3,7,0} sorted = {0,3,7} → minor root B.
    const auto tris = buildTriangles(0);
    const auto& t1 = tris[1];
    CHECK(t1.notes == std::array<PitchClass, 3>{2, 6, 11});
    CHECK(t1.rootPc == 11);
    CHECK(t1.quality == Quality::Minor);
}

TEST_CASE("triangleAt — interior centroid hits, far point misses", "[lattice][hit-test]")
{
    const auto tris = buildTriangles(0);

    SECTION("centroid of triangle 0 hits triangle 0") {
        const auto& c = tris[0].centroid;
        CHECK(triangleAt(c.x, c.y, tris) == 0);
    }
    SECTION("centroid of triangle 1 hits triangle 1") {
        const auto& c = tris[1].centroid;
        CHECK(triangleAt(c.x, c.y, tris) == 1);
    }
    SECTION("point well outside the lattice misses") {
        CHECK(triangleAt(0.0f, 0.0f, tris) == -1);
        CHECK(triangleAt(10000.0f, 10000.0f, tris) == -1);
    }
    SECTION("every triangle is hittable at its own centroid") {
        for (size_t i = 0; i < tris.size(); ++i) {
            const auto& c = tris[i].centroid;
            CHECK(triangleAt(c.x, c.y, tris) == static_cast<int>(i));
        }
    }
}

TEST_CASE("labelFor — natural / sharp / minor labels", "[lattice][label]")
{
    CHECK(std::string(labelFor(0, Quality::Major)) == "C");
    CHECK(std::string(labelFor(1, Quality::Major)) == "C#");
    CHECK(std::string(labelFor(11, Quality::Major)) == "B");
    CHECK(std::string(labelFor(0, Quality::Minor)) == "Cm");
    CHECK(std::string(labelFor(9, Quality::Minor)) == "Am");
}

namespace {

std::array<PitchClass, 3> sortPcs(int a, int b, int c)
{
    std::array<PitchClass, 3> out{a, b, c};
    std::sort(out.begin(), out.end());
    return out;
}

}  // namespace

TEST_CASE("resolveDragPath — empty input throws", "[lattice][resolve]")
{
    CHECK_THROWS_AS(resolveDragPath({}, 60), std::invalid_argument);
}

TEST_CASE("resolveDragPath — single tri yields newStartChord, no ops", "[lattice][resolve]")
{
    SECTION("C major in MIDI octave 5 (reference 60)") {
        const auto r = resolveDragPath({{0, 4, 7}}, 60);
        CHECK(r.newStartChord == Triad{60, 64, 67});
        CHECK(r.ops.empty());
    }
    SECTION("octave follows referenceMidi") {
        const auto r = resolveDragPath({{0, 4, 7}}, 72);
        CHECK(r.newStartChord == Triad{72, 76, 79});
    }
    SECTION("PC ordering bumped +12 to enforce ascending (mirrors inboil)") {
        // {2, 7, 11} placed in oct 5: (62, 67, 71) — already ascending.
        const auto r = resolveDragPath({{2, 7, 11}}, 60);
        CHECK(r.newStartChord == Triad{62, 67, 71});
    }
}

TEST_CASE("resolveDragPath — adjacent pairs resolve to P/L/R", "[lattice][resolve]")
{
    SECTION("C major → C minor (P)") {
        const auto r = resolveDragPath({sortPcs(0, 4, 7), sortPcs(0, 3, 7)}, 60);
        CHECK(r.ops == std::vector<Transform>{Transform::P});
    }
    SECTION("C major → E minor (L)") {
        const auto r = resolveDragPath({sortPcs(0, 4, 7), sortPcs(4, 7, 11)}, 60);
        CHECK(r.ops == std::vector<Transform>{Transform::L});
    }
    SECTION("C major → A minor (R)") {
        const auto r = resolveDragPath({sortPcs(0, 4, 7), sortPcs(0, 4, 9)}, 60);
        CHECK(r.ops == std::vector<Transform>{Transform::R});
    }
}

TEST_CASE("resolveDragPath — non-adjacent pair silently skipped", "[lattice][resolve]")
{
    // C major → G major: no single P/L/R produces (2,7,11) from C major.
    const auto r = resolveDragPath({sortPcs(0, 4, 7), sortPcs(2, 7, 11)}, 60);
    CHECK(r.ops.empty());
    CHECK(r.newStartChord == Triad{60, 64, 67});
}

TEST_CASE("resolveDragPath — three-triangle path chains transforms", "[lattice][resolve]")
{
    // C major → C minor (P) → Ab major (L). Ab major sorted PCs = (0, 3, 8).
    const auto r = resolveDragPath(
        {sortPcs(0, 4, 7), sortPcs(0, 3, 7), sortPcs(0, 3, 8)}, 60);
    CHECK(r.ops == std::vector<Transform>{Transform::P, Transform::L});
}

TEST_CASE("resolveDragPath — chord state advances only on match (skip preserves state)", "[lattice][resolve]")
{
    // C major → G major (skip) → C minor (P from C major). The skipped pair
    // must NOT advance internal chord state, so the P from C major still works.
    const auto r = resolveDragPath(
        {sortPcs(0, 4, 7), sortPcs(2, 7, 11), sortPcs(0, 3, 7)}, 60);
    CHECK(r.ops == std::vector<Transform>{Transform::P});
}
