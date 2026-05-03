// Oedipa AudioProcessor — ADR 008 Phase 2 scope.
//
//   - APVTS holds all numeric / enum parameters at parity with m4l
//     HostParams (modulo the chordQuality divergence per ADR 008).
//   - Non-APVTS state (cells, slots, anchors, startChord) lives as
//     plain data members and serializes into a child ValueTree of
//     apvts.state under tag "OedipaState" with a `version` attribute.
//   - processBlock is MIDI passthrough — no engine wiring yet (Phase 3).
//
// Public mutator methods (setStartChord / setCell / setSlot / setAnchors)
// exist primarily so tests can mutate state directly; later phases will
// route real interaction through them.

#pragma once

#include "Engine/State.h"
#include "Engine/Tonnetz.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <vector>

namespace oedipa {
namespace plugin {

class OedipaProcessor : public juce::AudioProcessor
{
public:
    static constexpr int kCellCount = 8;
    static constexpr int kSlotCount = 4;
    static constexpr int kStateVersion = 1;

    // Bus-configuration factory. Per ADR 008 §"DAW integration":
    //   - Live's VST3 host rejects plugins with zero audio buses
    //     ("plugin has an effect category, but no valid audio input
    //     bus"), so under Live we add a stub stereo output bus that
    //     processBlock never writes to. JUCE's MidiLogger workaround
    //     (commit 6ed49ff74f, 2020).
    //   - Every other host gets zero buses, so AU's
    //     kAudioUnitType_MIDIProcessor classification (set by JUCE's
    //     IS_MIDI_EFFECT TRUE) stays clean for Logic's MIDI FX slot.
    // Pure static — exposed so tests can drive both branches without
    // faking host detection. Lives on the class because BusesProperties
    // is a protected nested type of juce::AudioProcessor.
    static BusesProperties makeBusesProperties(bool addLiveStubOutput);

    OedipaProcessor();
    ~OedipaProcessor() override = default;

    // --- juce::AudioProcessor overrides -------------------------------------
    void prepareToPlay(double sampleRate, int samplesPerBlock) override;
    void releaseResources() override;
    void processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer&) override;

    juce::AudioProcessorEditor* createEditor() override;
    bool hasEditor() const override { return true; }

    const juce::String getName() const override { return "Oedipa"; }
    bool acceptsMidi() const override { return true; }
    bool producesMidi() const override { return true; }
    bool isMidiEffect() const override { return true; }
    double getTailLengthSeconds() const override { return 0.0; }

    int getNumPrograms() override { return 1; }
    int getCurrentProgram() override { return 0; }
    void setCurrentProgram(int) override {}
    const juce::String getProgramName(int) override { return {}; }
    void changeProgramName(int, const juce::String&) override {}

    void getStateInformation(juce::MemoryBlock&) override;
    void setStateInformation(const void*, int) override;

    // --- State accessors (read-only state, mutators below) ------------------
    juce::AudioProcessorValueTreeState& getApvts() { return apvts; }
    const juce::AudioProcessorValueTreeState& getApvts() const { return apvts; }

    engine::Triad getStartChord() const { return startChord; }
    void setStartChord(engine::Triad value) { startChord = value; }

    const engine::Cell& getCell(int idx) const { return cells.at((std::size_t) idx); }
    void setCell(int idx, const engine::Cell& cell) { cells.at((std::size_t) idx) = cell; }

    const engine::Slot& getSlot(int idx) const { return slots.at((std::size_t) idx); }
    void setSlot(int idx, const engine::Slot& slot) { slots.at((std::size_t) idx) = slot; }

    const std::vector<engine::Anchor>& getAnchors() const { return anchors; }
    void setAnchors(std::vector<engine::Anchor> value) { anchors = std::move(value); }

private:
    juce::AudioProcessorValueTreeState apvts;

    engine::Triad startChord{60, 64, 67};   // C major (C4 E4 G4)
    std::array<engine::Cell, kCellCount> cells{};
    std::array<engine::Slot, kSlotCount> slots{};
    std::vector<engine::Anchor> anchors{};

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OedipaProcessor)
};

}  // namespace plugin
}  // namespace oedipa
