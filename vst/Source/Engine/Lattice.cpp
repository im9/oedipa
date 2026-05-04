#include "Lattice.h"

#include <stdexcept>

namespace oedipa {
namespace engine {

namespace {

constexpr PitchClass mod12(int n)
{
    return ((n % 12) + 12) % 12;
}

std::array<PitchClass, 3> sortedPcs(const Triad& t)
{
    std::array<PitchClass, 3> pcs{mod12(t[0]), mod12(t[1]), mod12(t[2])};
    if (pcs[0] > pcs[1]) std::swap(pcs[0], pcs[1]);
    if (pcs[1] > pcs[2]) std::swap(pcs[1], pcs[2]);
    if (pcs[0] > pcs[1]) std::swap(pcs[0], pcs[1]);
    return pcs;
}

float edgeSign(Point2 p, Point2 a, Point2 b)
{
    return (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y);
}

bool pointInTriangle(Point2 p, const std::array<Point2, 3>& v)
{
    const float d1 = edgeSign(p, v[0], v[1]);
    const float d2 = edgeSign(p, v[1], v[2]);
    const float d3 = edgeSign(p, v[2], v[0]);
    const bool hasNeg = (d1 < 0.0f) || (d2 < 0.0f) || (d3 < 0.0f);
    const bool hasPos = (d1 > 0.0f) || (d2 > 0.0f) || (d3 > 0.0f);
    return !(hasNeg && hasPos);
}

}  // namespace

PitchClass pcAt(int row, int col, PitchClass centerPc, const LatticeGeometry& geo)
{
    const int cr = geo.rowCount / 2;
    const int cc = geo.colCount / 2;
    return mod12(centerPc + (col - cc) * 7 + (row - cr) * 4);
}

Point2 vertexAt(int row, int col, const LatticeGeometry& geo)
{
    return {
        geo.pad + col * geo.triW + row * geo.triW * 0.5f,
        geo.pad + row * geo.triH,
    };
}

float latticeWidth(const LatticeGeometry& geo)
{
    return geo.pad * 2.0f + (geo.colCount - 1) * geo.triW + (geo.rowCount - 1) * geo.triW * 0.5f;
}

float latticeHeight(const LatticeGeometry& geo)
{
    return geo.pad * 2.0f + (geo.rowCount - 1) * geo.triH;
}

namespace {

Triangle makeTriangle(Point2 p1, Point2 p2, Point2 p3,
                      PitchClass na, PitchClass nb, PitchClass nc)
{
    // PC sort to canonical form so state matching (current/playing/walk)
    // compares identically regardless of vertex order.
    std::array<PitchClass, 3> sorted{mod12(na), mod12(nb), mod12(nc)};
    if (sorted[0] > sorted[1]) std::swap(sorted[0], sorted[1]);
    if (sorted[1] > sorted[2]) std::swap(sorted[1], sorted[2]);
    if (sorted[0] > sorted[1]) std::swap(sorted[0], sorted[1]);

    PitchClass rootPc = sorted[0];
    Quality quality = Quality::Major;
    bool found = false;
    for (auto pc : sorted) {
        std::array<int, 3> ints{mod12(sorted[0] - pc), mod12(sorted[1] - pc), mod12(sorted[2] - pc)};
        if (ints[0] > ints[1]) std::swap(ints[0], ints[1]);
        if (ints[1] > ints[2]) std::swap(ints[1], ints[2]);
        if (ints[0] > ints[1]) std::swap(ints[0], ints[1]);
        if (ints[0] == 0 && ints[1] == 4 && ints[2] == 7) {
            rootPc = pc;
            quality = Quality::Major;
            found = true;
            break;
        }
        if (ints[0] == 0 && ints[1] == 3 && ints[2] == 7) {
            rootPc = pc;
            quality = Quality::Minor;
            found = true;
            break;
        }
    }
    // The Tonnetz lattice geometry guarantees every triangle is a major or
    // minor triad. If this throws, geometry constants drifted.
    if (!found) throw std::logic_error("makeTriangle: lattice produced a non-major/minor triad");

    return {
        {p1, p2, p3},
        {(p1.x + p2.x + p3.x) / 3.0f, (p1.y + p2.y + p3.y) / 3.0f},
        sorted,
        rootPc,
        quality,
    };
}

}  // namespace

std::vector<Triangle> buildTriangles(PitchClass centerPc, const LatticeGeometry& geo)
{
    const int rows = geo.rowCount - 1;
    const int cols = geo.colCount - 1;
    std::vector<Triangle> tris;
    tris.reserve(rows * cols * 2);
    for (int r = 0; r < rows; ++r) {
        for (int c = 0; c < cols; ++c) {
            // Upward (major): (r,c), (r,c+1), (r+1,c)
            tris.push_back(makeTriangle(
                vertexAt(r, c, geo), vertexAt(r, c + 1, geo), vertexAt(r + 1, c, geo),
                pcAt(r, c, centerPc, geo), pcAt(r, c + 1, centerPc, geo), pcAt(r + 1, c, centerPc, geo)));
            // Downward (minor): (r+1,c), (r+1,c+1), (r,c+1)
            tris.push_back(makeTriangle(
                vertexAt(r + 1, c, geo), vertexAt(r + 1, c + 1, geo), vertexAt(r, c + 1, geo),
                pcAt(r + 1, c, centerPc, geo), pcAt(r + 1, c + 1, centerPc, geo), pcAt(r, c + 1, centerPc, geo)));
        }
    }
    return tris;
}

int triangleAt(float x, float y, const std::vector<Triangle>& triangles)
{
    const Point2 p{x, y};
    for (size_t i = 0; i < triangles.size(); ++i) {
        if (pointInTriangle(p, triangles[i].vertices)) {
            return static_cast<int>(i);
        }
    }
    return -1;
}

const char* labelFor(PitchClass rootPc, Quality quality)
{
    static const char* const kMajor[12] = {
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    };
    static const char* const kMinor[12] = {
        "Cm", "C#m", "Dm", "D#m", "Em", "Fm", "F#m", "Gm", "G#m", "Am", "A#m", "Bm",
    };
    const int idx = mod12(rootPc);
    return (quality == Quality::Major) ? kMajor[idx] : kMinor[idx];
}

Triad rebuildTriadInOctave(std::array<PitchClass, 3> sortedPcs, MidiNote referenceMidi)
{
    // MIDI is non-negative in our domain; integer division equals floor.
    const int oct = referenceMidi / 12;
    Triad t{
        oct * 12 + sortedPcs[0],
        oct * 12 + sortedPcs[1],
        oct * 12 + sortedPcs[2],
    };
    if (t[1] < t[0]) t[1] += 12;
    if (t[2] < t[1]) t[2] += 12;
    return t;
}

DragResolution resolveDragPath(
    const std::vector<std::array<PitchClass, 3>>& pathPcs,
    MidiNote referenceMidi)
{
    if (pathPcs.empty()) {
        throw std::invalid_argument("resolveDragPath: pathPcs must be non-empty");
    }

    const Triad start = rebuildTriadInOctave(pathPcs[0], referenceMidi);

    DragResolution result;
    result.newStartChord = start;
    result.ops.reserve(pathPcs.size() - 1);

    Triad chord = start;
    for (size_t i = 1; i < pathPcs.size(); ++i) {
        for (Transform op : {Transform::P, Transform::L, Transform::R}) {
            const Triad candidate = applyTransform(chord, op);
            if (sortedPcs(candidate) == pathPcs[i]) {
                result.ops.push_back(op);
                chord = candidate;
                break;
            }
        }
        // No single P/L/R matches → silently skip (chord state unchanged),
        // mirroring inboil's "non-adjacent triangles" fallback.
    }

    return result;
}

}  // namespace engine
}  // namespace oedipa
