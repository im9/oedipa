// APVTS parameter IDs and layout factory (ADR 008 Phase 2).
//
// Parity with m4l HostParams (m4l/host/host.ts) for everything the host's
// parameter system can natively represent: numerics and named-string enums.
// Non-APVTS state (cells, slots, anchors, startChord) lives on the
// processor and serializes into a child ValueTree of apvts.state — see
// PluginProcessor.cpp.
//
// One intentional divergence from m4l (per ADR 008): chord quality is
// `chordQuality` Choice ('triad'|'7th'), not `seventh` bool.

#pragma once

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>

namespace oedipa {
namespace plugin {

namespace pid {
inline constexpr const char* stepsPerTransform = "stepsPerTransform";
inline constexpr const char* voicing           = "voicing";
inline constexpr const char* chordQuality      = "chordQuality";
inline constexpr const char* jitter            = "jitter";
inline constexpr const char* seed              = "seed";
inline constexpr const char* channel           = "channel";
inline constexpr const char* triggerMode       = "triggerMode";
inline constexpr const char* inputChannel      = "inputChannel";
inline constexpr const char* stepDirection     = "stepDirection";
inline constexpr const char* outputLevel       = "outputLevel";
inline constexpr const char* rhythm            = "rhythm";
inline constexpr const char* arp               = "arp";
inline constexpr const char* length            = "length";
inline constexpr const char* turingLength      = "turingLength";
inline constexpr const char* turingLock        = "turingLock";
inline constexpr const char* turingSeed        = "turingSeed";
}  // namespace pid

// Choice strings — the Choice index is what APVTS persists, so the order of
// these arrays is the wire format. NEVER reorder; only append.
//
// The strings mirror m4l's named-string enums (engine/tonnetz.ts) so a
// future cross-target preset converter has a 1:1 string mapping.
inline const juce::StringArray voicingChoices       { "close", "spread", "drop2" };
inline const juce::StringArray chordQualityChoices  { "triad", "7th" };
inline const juce::StringArray triggerModeChoices   { "hybrid", "hold" };
inline const juce::StringArray stepDirectionChoices { "forward", "reverse", "pingpong", "random" };
inline const juce::StringArray rhythmChoices        { "all", "legato", "onbeat", "offbeat", "syncopated", "turing" };
inline const juce::StringArray arpChoices           { "off", "up", "down", "updown", "random" };

// Defaults are stored centrally so the round-trip test can assert "fresh
// instance has these exact values." Numeric defaults match m4l's shipping
// initial values where they exist; anything not pinned by m4l (the m4l
// patcher owns initial values via hidden live.numbox) is set to a musically
// sensible neutral.
namespace defaults {
inline constexpr int   stepsPerTransform = 4;
inline constexpr int   voicingIdx        = 0;       // close
inline constexpr int   chordQualityIdx   = 0;       // triad (= m4l seventh=false)
inline constexpr float jitter            = 0.0f;
inline constexpr int   seed              = 0;
inline constexpr int   channel           = 1;       // MIDI ch 1
inline constexpr int   triggerModeIdx    = 0;       // hybrid
inline constexpr int   inputChannel      = 0;       // omni
inline constexpr int   stepDirectionIdx  = 0;       // forward
inline constexpr float outputLevel       = 1.0f;
inline constexpr int   rhythmIdx         = 1;       // legato (cell-head fires only)
inline constexpr int   arpIdx            = 0;       // off
inline constexpr int   length            = 4;
inline constexpr int   turingLength      = 8;       // inboil default
inline constexpr float turingLock        = 0.7f;    // inboil default
inline constexpr int   turingSeed        = 0;
}  // namespace defaults

// APVTS layout factory. Called once from the processor constructor.
juce::AudioProcessorValueTreeState::ParameterLayout makeParameterLayout();

}  // namespace plugin
}  // namespace oedipa
