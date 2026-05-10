#include "Engine/Rhythm.h"

#include <algorithm>
#include <array>

namespace oedipa {
namespace engine {

namespace {

// Inboil's spec-corrected syncopated pattern (see m4l/engine/tonnetz.ts:72).
constexpr std::array<bool, 8> kSyncopatedPattern{
    true, false, true, false, false, true, false, true
};

}  // namespace

bool gatingFires(RhythmPreset mode, int subStepIdx)
{
    // Negative sub-step indices are illegal callers (the host should
    // never request gating before pos=0). Clamp defensively.
    const int idx = std::max(0, subStepIdx);
    switch (mode) {
        case RhythmPreset::All:        return true;
        case RhythmPreset::Legato:     return idx == 0;
        case RhythmPreset::Onbeat:     return (idx % 4) == 0;
        case RhythmPreset::Offbeat:    return (idx % 4) == 2;
        case RhythmPreset::Syncopated: {
            const std::size_t mod = (std::size_t) idx % kSyncopatedPattern.size();
            return kSyncopatedPattern[mod];
        }
        case RhythmPreset::Turing:
            // Turing isn't stateless — caller must use turingFires().
            // Returning false here matches a defensive "don't fire" rather
            // than asserting; processBlock should branch on Turing before
            // calling this.
            return false;
    }
    return false;
}

int fireIntervalSubsteps(RhythmPreset mode, int stepsPerTransform)
{
    const int spt = std::max(1, stepsPerTransform);
    switch (mode) {
        case RhythmPreset::Legato:     return spt;
        case RhythmPreset::All:        return 1;
        case RhythmPreset::Onbeat:     return 4;
        case RhythmPreset::Offbeat:    return 4;
        case RhythmPreset::Syncopated: return 1;
        case RhythmPreset::Turing:     return 1;
    }
    return 1;
}

TuringRhythmState makeTuringState(int length, std::uint32_t seed)
{
    // Construct with a placeholder rng (Mulberry32 has no default ctor);
    // resetTuringState immediately overwrites it with Mulberry32{seed}.
    TuringRhythmState state{ {}, Mulberry32{0u} };
    resetTuringState(state, length, seed);
    return state;
}

void resetTuringState(TuringRhythmState& state, int length, std::uint32_t seed)
{
    const int len = std::clamp(length, kTuringLengthMin, kTuringLengthMax);
    state.rng = Mulberry32{seed};
    // resize() reallocates only when len > capacity. Audio-thread callers
    // pre-reserve to kTuringLengthMax once at warmup (PluginProcessor
    // constructor) so this is alloc-free for any in-range len.
    state.reg.resize((std::size_t) len);
    for (int i = 0; i < len; ++i) {
        state.reg[(std::size_t) i] = state.rng.next() < 0.5f ? 1 : 0;
    }
}

bool turingFires(TuringRhythmState& state, float lock)
{
    const int len = (int) state.reg.size();
    if (len <= 0) return false;

    // Sum register bits as an integer fraction over (2^len - 1). Length is
    // clamped to ≤ 32 by makeTuringState so the shift fits in uint32 (with
    // 1u << 32 specifically avoided by the `len < 32` short-circuit; at
    // len=32 the denominator is 2^32 - 1 which we represent as UINT32_MAX).
    std::uint64_t sum = 0;
    for (int i = 0; i < len; ++i) {
        sum += (std::uint64_t) state.reg[(std::size_t) i] << i;
    }
    const std::uint64_t denom = (len >= 32) ? (std::uint64_t) 0xFFFFFFFFu
                                            : (((std::uint64_t) 1 << len) - 1);
    const std::uint64_t safeDenom = denom == 0 ? 1 : denom;
    const float frac = (float) ((double) sum / (double) safeDenom);
    const bool fires = frac >= 0.5f;

    const float lockClamped = std::clamp(lock, 0.0f, 1.0f);
    const float flipProb = 1.0f - lockClamped;
    const int lastBit = state.reg[(std::size_t) (len - 1)];
    for (int j = len - 1; j > 0; --j) {
        state.reg[(std::size_t) j] = state.reg[(std::size_t) (j - 1)];
    }
    state.reg[0] = (state.rng.next() < flipProb) ? (1 - lastBit) : lastBit;
    return fires;
}

std::optional<int> arpIndex(ArpMode mode, int chordSize, int fireIdx, Mulberry32& rng)
{
    if (mode == ArpMode::Off || chordSize <= 0) return std::nullopt;
    if (chordSize == 1) return 0;

    const int idx = fireIdx % std::max(1, chordSize);
    switch (mode) {
        case ArpMode::Up:     return idx;
        case ArpMode::Down:   return chordSize - 1 - idx;
        case ArpMode::UpDown: {
            const int period = 2 * (chordSize - 1);
            if (period <= 0) return 0;
            const int i = fireIdx % period;
            return i < chordSize ? i : period - i;
        }
        case ArpMode::Random: {
            const int pick = (int) (rng.next() * (float) chordSize);
            return std::clamp(pick, 0, chordSize - 1);
        }
        case ArpMode::Off:    return std::nullopt;  // unreachable, guarded above
    }
    return std::nullopt;
}

}  // namespace engine
}  // namespace oedipa
