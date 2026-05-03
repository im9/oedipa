#include "Tonnetz.h"

#include <algorithm>

namespace oedipa {
namespace engine {

namespace {

constexpr PitchClass mod12(int n)
{
    return ((n % 12) + 12) % 12;
}

}  // namespace

TriadIdentity identifyTriad(Triad triad)
{
    const std::array<PitchClass, 3> pcs = {mod12(triad[0]), mod12(triad[1]), mod12(triad[2])};
    for (auto pc : pcs) {
        std::array<int, 3> ints = {mod12(pcs[0] - pc), mod12(pcs[1] - pc), mod12(pcs[2] - pc)};
        std::sort(ints.begin(), ints.end());
        if (ints[0] == 0 && ints[1] == 4 && ints[2] == 7) return {pc, Quality::Major};
        if (ints[0] == 0 && ints[1] == 3 && ints[2] == 7) return {pc, Quality::Minor};
    }
    throw std::invalid_argument("identifyTriad: input is not a major or minor triad");
}

Triad buildTriad(PitchClass rootPc, Quality quality, MidiNote reference)
{
    // MIDI is non-negative, so plain integer division equals floor here.
    int root = (reference / 12) * 12 + rootPc;
    if (root - reference > 6) root -= 12;
    if (reference - root > 6) root += 12;
    while (root < 36) root += 12;
    while (root > 84) root -= 12;
    const int third = root + (quality == Quality::Minor ? 3 : 4);
    const int fifth = root + 7;
    return {root, third, fifth};
}

Triad applyTransform(Triad triad, Transform op)
{
    const auto id = identifyTriad(triad);
    const Quality newQuality = (id.quality == Quality::Major) ? Quality::Minor : Quality::Major;
    PitchClass newRoot = 0;
    switch (op) {
        case Transform::P:
            newRoot = id.rootPc;
            break;
        case Transform::L:
            newRoot = (id.quality == Quality::Major) ? mod12(id.rootPc + 4) : mod12(id.rootPc + 8);
            break;
        case Transform::R:
            newRoot = (id.quality == Quality::Major) ? mod12(id.rootPc + 9) : mod12(id.rootPc + 3);
            break;
    }
    return buildTriad(newRoot, newQuality, triad[0]);
}

std::vector<MidiNote> applyVoicing(Triad triad, Voicing mode)
{
    const auto a = triad[0];
    const auto b = triad[1];
    const auto c = triad[2];
    switch (mode) {
        case Voicing::Close:  return {a, b, c};
        case Voicing::Spread: return {a, b + 12, c};
        case Voicing::Drop2:  return {a, c, b + 12};
    }
    throw std::invalid_argument("applyVoicing: unknown mode");
}

std::vector<MidiNote> addSeventh(const std::vector<MidiNote>& notes, Quality quality)
{
    if (notes.empty()) throw std::invalid_argument("addSeventh: empty notes");
    auto out = notes;
    out.push_back(notes.front() + (quality == Quality::Major ? 11 : 10));
    return out;
}

}  // namespace engine
}  // namespace oedipa
