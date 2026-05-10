// Tonnetz engine — pure C++17 port of the contract in
// docs/ai/adr/archive/001-tonnetz-engine-interface.md.
//
// ADR 008 boundary: this header (and everything else under Source/Engine/)
// MUST NOT include any <juce_*> header. Engine code is the iOS-reuse layer
// and is consumed unchanged by JUCE (vst/) and SwiftUI (future app/).
// Reviewers: a juce include below this line is a blocker.

#pragma once

#include <array>
#include <stdexcept>
#include <vector>

namespace oedipa {
namespace engine {

using PitchClass = int;  // 0..11
using MidiNote = int;    // 0..127

enum class Quality { Major, Minor };
enum class Transform { P, L, R };
enum class Voicing { Close, Spread, Drop2 };

using Triad = std::array<MidiNote, 3>;

struct TriadIdentity {
    PitchClass rootPc;
    Quality quality;
};

// Throws std::invalid_argument if the input is not a major or minor triad
// in any inversion.
TriadIdentity identifyTriad(Triad triad);

// Constructs a root-position triad [r, r+3|4, r+7] in the octave nearest
// to `reference`, clamped to the playable register (root in [36, 84]).
Triad buildTriad(PitchClass rootPc, Quality quality, MidiNote reference);

// Identify → flip in pitch-class space → rebuild near the input root.
Triad applyTransform(Triad triad, Transform op);

// Apply the voicing layer:
//   close  → [a, b, c]
//   spread → [a, b+12, c]
//   drop2  → [a, c, b+12]
std::vector<MidiNote> applyVoicing(Triad triad, Voicing mode);

// Append a 7th above the root: +11 for major (maj7), +10 for minor (min7).
// `root` is the root MIDI note — explicit so the function does not depend
// on the convention that voicing index 0 is the root. (close / spread /
// drop2 all keep root at index 0, but a future inversion voicing would
// silently emit the wrong 7th if addSeventh assumed `notes.front()`.)
std::vector<MidiNote> addSeventh(const std::vector<MidiNote>& notes, Quality quality, MidiNote root);

}  // namespace engine
}  // namespace oedipa
