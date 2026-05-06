// Oedipa AudioProcessor — ADR 008 Phases 2 + 3.
//
//   - APVTS holds all numeric / enum parameters at parity with m4l
//     HostParams (modulo the chordQuality divergence per ADR 008).
//   - Non-APVTS state (cells, slots, anchors, startChord) lives as
//     plain data members and serializes into a child ValueTree of
//     apvts.state under tag "OedipaState" with a `version` attribute.
//   - processBlock (Phase 3) drives engine::walkStepEvent from the host
//     playhead: each block, sub-step boundaries crossed since the prior
//     block fire MIDI note-on/off pairs at the configured channel +
//     voicing + (optional) maj7/min7 extension. Backward scrubs and
//     transport stops emit panic note-offs for held output notes so
//     dangling notes don't survive a position jump.
//
// Public mutator methods (setStartChord / setCell / setSlot / setAnchors)
// exist primarily so tests can mutate state directly; later phases will
// route real interaction through them.

#pragma once

#include "Engine/SlotBank.h"
#include "Engine/State.h"
#include "Engine/Tonnetz.h"
#include "Engine/Walker.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>
#include <utility>
#include <vector>

namespace oedipa {
namespace plugin {

class OedipaProcessor : public juce::AudioProcessor,
                        private juce::AudioProcessorValueTreeState::Listener
{
public:
    static constexpr int kCellCount = 8;
    static constexpr int kSlotCount = engine::kSlotCount;
    static constexpr int kStateVersion = 1;

    OedipaProcessor();
    ~OedipaProcessor() override;

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
    void setStartChord(engine::Triad value);

    const engine::Cell& getCell(int idx) const { return cells.at((std::size_t) idx); }
    void setCell(int idx, const engine::Cell& cell);

    // Drawer-side mutator — change one numeric field of the cell at `idx`
    // without disturbing op or other fields. Out-of-range idx and NaN
    // values are silently ignored (matches m4l host.setCellField). Does
    // NOT auto-save: per-cell vel/gate/prob/timing are device-shared, not
    // per-slot, per ADR 006 §"Axis 1" — the active slot only stores ops.
    void setCellField(int idx, engine::CellField field, float value);

    // Slot bank accessors. setSlot is rehydration-only — it stores into the
    // bank without applying to live state or changing the active index.
    const engine::Slot& getSlot(int idx) const { return bank.slotAt(idx); }
    void setSlot(int idx, const engine::Slot& slot) { bank.setSlot(idx, slot); }
    int activeSlotIndex() const { return bank.activeIndex(); }
    const engine::SlotBank& getSlotBank() const { return bank; }

    // === SlotBank wiring (ADR 008 Phase 5) ==================================
    // Snapshot the current live state into a Slot. Reads cells.op[i],
    // identifies startChord, and pulls jitter/seed from APVTS.
    engine::Slot captureSlot() const;

    // Apply a slot to live state. Writes cells.op (leaves vel/gate/prob/
    // timing untouched — those are device-shared per m4l ADR 006 §"Axis 1"),
    // rebuilds startChord at the current octave, and writes jitter/seed
    // into APVTS. Auto-save is suppressed during the call so the slot the
    // caller passed in stays the source of truth, not a partial-mid-apply
    // capture.
    void applySlot(const engine::Slot& slot);

    // Switch the active slot and apply its contents to live state. Out-of-
    // range index is a no-op.
    void switchSlot(int idx);

    // Mirror current live state into the active slot. Hooked from setCell /
    // setStartChord and from parameterChanged for jitter / seed / length.
    // Public so the editor can call it explicitly after composite edits.
    void syncActiveSlot();

    const std::vector<engine::Anchor>& getAnchors() const { return anchors; }
    void setAnchors(std::vector<engine::Anchor> value) { anchors = std::move(value); }

    // Editor-facing snapshot of the current walk inputs (startChord, cells,
    // anchors, etc. flattened from APVTS). Lets the lattice view compute the
    // walk path for trail rendering without re-reading APVTS itself.
    engine::WalkState makeWalkStateSnapshot() const { return makeWalkState(); }

    // Highest sub-step pos already emitted by the walker; -1 = transport
    // stopped (no chord is "playing"). Editor reads this to render the
    // playing-state highlight + chord-trail head position.
    int getLastSubStep() const { return lastSubStep; }

    // Editor-facing writebacks (Phase 4 lattice interactions). All run on the
    // message thread; processBlock reads the same fields on the audio thread.
    // Tearing windows are one-block (≤ ~12 ms) and musically inaudible —
    // matches the existing setStartChord / setCell relaxed-sync convention.
    //
    //   requestPreview        — lattice tap or long-press auditions a chord;
    //                           queued for emission on the next processBlock.
    //   applyDragResolution   — drag committed: replace startChord and
    //                           overwrite cells[0..ops.size()-1] with the
    //                           resolved P/L/R sequence; `length` follows.
    //                           No-op when ops is empty (per inboil).
    //   addAnchorAtNextStep   — long-press: append an anchor at
    //                           max(existing anchor steps) + spt*4 (or
    //                           spt*4 if no prior anchor), with the given
    //                           triangle's (rootPc, quality).
    void requestPreview(engine::Triad chord);
    void applyDragResolution(engine::Triad newStartChord,
                             const std::vector<engine::Transform>& ops);
    void addAnchorAtNextStep(engine::PitchClass rootPc, engine::Quality quality);

    // Test-facing inspection of the walker's current play state. Lets the
    // Phase 3 processBlock test verify held-note bookkeeping without
    // poking the private member directly.
    int getLastSubStepForTest() const { return lastSubStep; }
    const std::vector<std::pair<int, int>>& getHeldForTest() const { return held; }
    const std::vector<std::pair<int, int>>& getPreviewHeldForTest() const { return previewHeld; }
    bool isPreviewActiveForTest() const { return ! previewHeld.empty(); }

private:
    juce::AudioProcessorValueTreeState apvts;

    engine::Triad startChord{60, 64, 67};   // C major (C4 E4 G4)
    std::array<engine::Cell, kCellCount> cells{};
    engine::SlotBank bank{};
    std::vector<engine::Anchor> anchors{};

    // Defangs auto-save recursion during applySlot / setStateInformation:
    // listener fires from APVTS writes are no-ops while this is true.
    bool suppressAutoSave = false;

    // juce::AudioProcessorValueTreeState::Listener
    void parameterChanged(const juce::String& parameterID, float newValue) override;

    // Walker state — tracked across processBlock calls.
    //   lastSubStep: highest sub-step pos already emitted (-1 = nothing
    //                emitted since the last transport (re)start). Atomic
    //                because the editor's lattice paint reads this from
    //                the message thread to drive the playing-chord
    //                highlight; processBlock writes from the audio thread.
    //   held: (channel, midiNote) currently sounding from walker output.
    std::atomic<int> lastSubStep{-1};
    std::vector<std::pair<int, int>> held;

    // Preview MIDI (lattice tap / long-press audition). Lock-free hand-off:
    // the editor stores `pendingPreviewChord`, then flips
    // `previewRequested` with release-store. processBlock reads the flag
    // with acquire-load and consumes the chord in the same block.
    std::atomic<bool> previewRequested{false};
    engine::Triad pendingPreviewChord{};
    double sampleRate = 44100.0;
    int previewSamplesUntilOff = 0;
    std::vector<std::pair<int, int>> previewHeld;

    engine::WalkState makeWalkState() const;
    void emitPanic(juce::MidiBuffer&, int sampleOffset);
    void emitChord(juce::MidiBuffer&,
                   const engine::Triad&,
                   engine::Voicing,
                   bool seventh,
                   int channel,
                   float velocity,
                   int sampleOffset);
    void handlePreviewMidi(juce::MidiBuffer&, int blockSamples);
    void handleWalkerMidi(juce::MidiBuffer&);

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OedipaProcessor)
};

}  // namespace plugin
}  // namespace oedipa
