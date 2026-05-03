#include "Walker.h"

#include <array>

namespace oedipa {
namespace engine {

namespace {

// Mulberry32 PRNG — bit-for-bit clone of m4l/engine/tonnetz.ts (and the
// algorithm pinned in docs/ai/tonnetz-test-vectors.json "mulberry32"). The
// 32-bit multiply uses uint64_t to avoid signed-overflow UB; the rest is
// straight uint32 arithmetic that wraps the same way Math.imul does in JS.
class Mulberry32
{
public:
    explicit Mulberry32(std::uint32_t seed) : a(seed) {}

    float next()
    {
        a = a + 0x6D2B79F5u;
        std::uint32_t t = a;
        t = imul(t ^ (t >> 15), t | 1u);
        t = t ^ (t + imul(t ^ (t >> 7), t | 61u));
        const std::uint32_t out = t ^ (t >> 14);
        return static_cast<float>(static_cast<double>(out) / 4294967296.0);
    }

private:
    static std::uint32_t imul(std::uint32_t x, std::uint32_t y)
    {
        return static_cast<std::uint32_t>(static_cast<std::uint64_t>(x) *
                                           static_cast<std::uint64_t>(y));
    }

    std::uint32_t a;
};

// CELL_OPS pool for jitter substitution — order pinned by m4l (Phase 3
// cross-target conformance). 'rest' is excluded by design (ADR 005: a
// rest cell never substitutes, so the silent gesture remains author-
// controlled regardless of jitter).
constexpr std::array<Op, 4> kCellOpsForJitter{Op::P, Op::L, Op::R, Op::Hold};

int resolveCellIdx(int transformIdx, int cellsLength, StepDirection direction, Mulberry32& rng)
{
    if (cellsLength <= 0) return 0;
    switch (direction) {
        case StepDirection::Random: {
            const float r = rng.next();
            int idx = static_cast<int>(r * static_cast<float>(cellsLength));
            if (idx >= cellsLength) idx = cellsLength - 1;  // [0,1) * N may round up at fp boundary
            return idx;
        }
        case StepDirection::Forward:
            return transformIdx % cellsLength;
        case StepDirection::Reverse: {
            const int raw = (cellsLength - 1 - transformIdx) % cellsLength;
            return ((raw % cellsLength) + cellsLength) % cellsLength;
        }
        case StepDirection::Pingpong: {
            if (cellsLength <= 1) return 0;
            const int period = 2 * (cellsLength - 1);
            int idx = ((transformIdx % period) + period) % period;
            return idx < cellsLength ? idx : period - idx;
        }
    }
    return 0;
}

struct BoundaryOutcome {
    Op resolvedOp;
    bool played;
    float humanizeVel;
    float humanizeGate;
    float humanizeTiming;
};

// Per-boundary state advance + PRNG draws. Draw order is the binding
// contract from ADR 005 §"PRNG draw order" — must match m4l for the
// vectors in `walk_jitter` to hold cross-target.
BoundaryOutcome stepBoundary(Triad& cursor, const Cell& cell, float jitter, Mulberry32& rng)
{
    Op op = cell.op;

    if (jitter > 0.0f && op != Op::Rest) {
        const float rSub  = rng.next();
        const float rPick = rng.next();
        if (rSub < jitter) {
            int idx = static_cast<int>(rPick * static_cast<float>(kCellOpsForJitter.size()));
            if (idx >= static_cast<int>(kCellOpsForJitter.size())) idx = static_cast<int>(kCellOpsForJitter.size()) - 1;
            op = kCellOpsForJitter[static_cast<std::size_t>(idx)];
        }
    }

    const float rProb           = rng.next();
    const float humanizeVel     = rng.next();
    const float humanizeGate    = rng.next();
    const float humanizeTiming  = rng.next();

    if (op == Op::P || op == Op::L || op == Op::R) {
        Transform t = (op == Op::P) ? Transform::P : (op == Op::L ? Transform::L : Transform::R);
        cursor = applyTransform(cursor, t);
    }
    // Op::Hold and Op::Rest leave the cursor untouched (ADR 005).

    const bool played = (op != Op::Rest) && (op != Op::Hold) && (rProb < cell.probability);
    return {op, played, humanizeVel, humanizeGate, humanizeTiming};
}

// Linear scan — anchors are typically a handful, sorted by step. Returns
// the matching anchor at exactly `step`, or nullptr.
const Anchor* findAnchorAtStep(const std::vector<Anchor>& anchors, int step)
{
    for (const auto& a : anchors) {
        if (a.step == step) return &a;
    }
    return nullptr;
}

}  // namespace

Triad walk(const WalkState& state, int pos)
{
    Triad cursor = state.startChord;
    if (pos <= 0) {
        // Anchor at step 0 still applies even at pos=0.
        if (auto a = findAnchorAtStep(state.anchors, 0)) {
            cursor = buildTriad(a->rootPc, a->quality, cursor[0]);
        }
        return cursor;
    }

    Mulberry32 rng{state.seed};
    int transformIdx = 0;
    const int cellsLength = static_cast<int>(state.cells.size());
    const int spt = state.stepsPerTransform;

    for (int step = 0; step <= pos; ++step) {
        if (auto anchor = findAnchorAtStep(state.anchors, step)) {
            cursor = buildTriad(anchor->rootPc, anchor->quality, cursor[0]);
            transformIdx = 0;
            continue;
        }
        if (step == 0) continue;
        if (spt <= 0 || (step % spt) != 0) continue;
        if (cellsLength == 0) continue;

        const int cellIdx = resolveCellIdx(transformIdx, cellsLength, state.stepDirection, rng);
        const Cell& cell = state.cells[static_cast<std::size_t>(cellIdx)];
        stepBoundary(cursor, cell, state.jitter, rng);
        transformIdx += 1;
    }
    return cursor;
}

std::optional<StepEvent> walkStepEvent(const WalkState& state, int pos)
{
    if (pos <= 0) return std::nullopt;

    Mulberry32 rng{state.seed};
    Triad cursor = state.startChord;
    if (auto a = findAnchorAtStep(state.anchors, 0)) {
        cursor = buildTriad(a->rootPc, a->quality, cursor[0]);
    }

    int transformIdx = 0;
    const int cellsLength = static_cast<int>(state.cells.size());
    const int spt = state.stepsPerTransform;
    std::optional<StepEvent> result;

    for (int step = 1; step <= pos; ++step) {
        if (auto anchor = findAnchorAtStep(state.anchors, step)) {
            cursor = buildTriad(anchor->rootPc, anchor->quality, cursor[0]);
            transformIdx = 0;
            if (step == pos) {
                // Anchor fire — emit a StepEvent so the host re-attacks the
                // pinned chord. Humanize draws default to 0.5 (neutral) since
                // no PRNG draws happen at anchors.
                result = StepEvent{-1, Op::Hold, cursor, true, 0.5f, 0.5f, 0.5f};
            }
            continue;
        }
        if (spt <= 0 || (step % spt) != 0) continue;
        if (cellsLength == 0) continue;

        const int cellIdx = resolveCellIdx(transformIdx, cellsLength, state.stepDirection, rng);
        const Cell& cell = state.cells[static_cast<std::size_t>(cellIdx)];
        const auto outcome = stepBoundary(cursor, cell, state.jitter, rng);
        if (step == pos) {
            result = StepEvent{cellIdx, outcome.resolvedOp, cursor, outcome.played,
                               outcome.humanizeVel, outcome.humanizeGate, outcome.humanizeTiming};
        }
        transformIdx += 1;
    }
    return result;
}

}  // namespace engine
}  // namespace oedipa
