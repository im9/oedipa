// Mulberry32 PRNG — bit-for-bit clone of m4l/engine/tonnetz.ts and the
// algorithm pinned in docs/ai/tonnetz-test-vectors.json "mulberry32".
// The 32-bit multiply uses uint64 to avoid signed-overflow UB; the rest
// is straight uint32 arithmetic that wraps the same way Math.imul does
// in JS.
//
// Single header so the walker, rhythm gate, and ARP picker can seed
// independent streams from APVTS (seed / turingSeed) without each one
// re-defining the primitive. Previously the class lived in Walker.cpp
// as an anonymous-namespace symbol.

#pragma once

#include <cstdint>

namespace oedipa {
namespace engine {

class Mulberry32
{
public:
    explicit Mulberry32(std::uint32_t seed) : a(seed) {}

    // Returns double to match the JS reference (Math.imul + division yields
    // a Number = IEEE-754 double). The previous `static_cast<float>` form
    // dropped ~25 bits of precision on every draw — fine for the existing
    // cross-target test vectors (which compare booleans and chord PCs,
    // not raw PRNG floats), but a future high-precision sample table
    // pinned in `docs/ai/tonnetz-test-vectors.json::mulberry32.samples`
    // would diverge bit-for-bit. Callers that need a float still get one
    // via implicit narrowing.
    double next()
    {
        a = a + 0x6D2B79F5u;
        std::uint32_t t = a;
        t = imul(t ^ (t >> 15), t | 1u);
        t = t ^ (t + imul(t ^ (t >> 7), t | 61u));
        const std::uint32_t out = t ^ (t >> 14);
        return static_cast<double>(out) / 4294967296.0;
    }

private:
    static std::uint32_t imul(std::uint32_t x, std::uint32_t y)
    {
        return static_cast<std::uint32_t>(static_cast<std::uint64_t>(x) *
                                           static_cast<std::uint64_t>(y));
    }

    std::uint32_t a;
};

}  // namespace engine
}  // namespace oedipa
