#include "Plugin/Parameters.h"

namespace oedipa {
namespace plugin {

juce::AudioProcessorValueTreeState::ParameterLayout makeParameterLayout()
{
    using APF  = juce::AudioParameterFloat;
    using API  = juce::AudioParameterInt;
    using APC  = juce::AudioParameterChoice;
    using PID  = juce::ParameterID;

    // Version 1 == ADR 008 Phase 2 initial schema. Bump if any param ID
    // changes meaning or a Choice array is reordered.
    constexpr int kParamVersion = 1;

    juce::AudioProcessorValueTreeState::ParameterLayout layout;

    layout.add(std::make_unique<API>(
        PID{pid::stepsPerTransform, kParamVersion}, "Steps Per Transform",
        1, 32, defaults::stepsPerTransform));

    layout.add(std::make_unique<APC>(
        PID{pid::voicing, kParamVersion}, "Voicing",
        voicingChoices, defaults::voicingIdx));

    layout.add(std::make_unique<APC>(
        PID{pid::chordQuality, kParamVersion}, "Chord Quality",
        chordQualityChoices, defaults::chordQualityIdx));

    layout.add(std::make_unique<APF>(
        PID{pid::jitter, kParamVersion}, "Jitter",
        juce::NormalisableRange<float>(0.0f, 1.0f), defaults::jitter));

    // Seed: APVTS int caps at signed 32-bit; m4l uint32 high bit is
    // musically irrelevant (mulberry32 mixes the value), so the 31-bit
    // range here is wide enough.
    layout.add(std::make_unique<API>(
        PID{pid::seed, kParamVersion}, "Seed",
        0, std::numeric_limits<juce::int32>::max(), defaults::seed));

    layout.add(std::make_unique<API>(
        PID{pid::channel, kParamVersion}, "Channel",
        1, 16, defaults::channel));

    layout.add(std::make_unique<APC>(
        PID{pid::triggerMode, kParamVersion}, "Trigger Mode",
        triggerModeChoices, defaults::triggerModeIdx));

    layout.add(std::make_unique<API>(
        PID{pid::inputChannel, kParamVersion}, "Input Channel",
        0, 16, defaults::inputChannel));

    layout.add(std::make_unique<APC>(
        PID{pid::stepDirection, kParamVersion}, "Step Direction",
        stepDirectionChoices, defaults::stepDirectionIdx));

    layout.add(std::make_unique<APF>(
        PID{pid::outputLevel, kParamVersion}, "Output Level",
        juce::NormalisableRange<float>(0.0f, 1.0f), defaults::outputLevel));

    layout.add(std::make_unique<APC>(
        PID{pid::rhythm, kParamVersion}, "Rhythm",
        rhythmChoices, defaults::rhythmIdx));

    layout.add(std::make_unique<APC>(
        PID{pid::arp, kParamVersion}, "Arp",
        arpChoices, defaults::arpIdx));

    layout.add(std::make_unique<API>(
        PID{pid::length, kParamVersion}, "Length",
        1, 8, defaults::length));

    layout.add(std::make_unique<API>(
        PID{pid::turingLength, kParamVersion}, "Turing Length",
        2, 32, defaults::turingLength));

    layout.add(std::make_unique<APF>(
        PID{pid::turingLock, kParamVersion}, "Turing Lock",
        juce::NormalisableRange<float>(0.0f, 1.0f), defaults::turingLock));

    layout.add(std::make_unique<API>(
        PID{pid::turingSeed, kParamVersion}, "Turing Seed",
        0, std::numeric_limits<juce::int32>::max(), defaults::turingSeed));

    return layout;
}

}  // namespace plugin
}  // namespace oedipa
