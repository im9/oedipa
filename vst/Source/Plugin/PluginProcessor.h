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

#include "Engine/Rhythm.h"
#include "Engine/Rng.h"
#include "Engine/SlotBank.h"
#include "Engine/State.h"
#include "Engine/Tonnetz.h"
#include "Engine/Walker.h"

#include <juce_audio_processors/juce_audio_processors.h>

#include <array>
#include <atomic>
#include <memory>
#include <optional>
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

    // anchors API is message-thread (editor + tests). Audio thread reads
    // the lock-free shared_ptr snapshot via populateAudioWalkState — see
    // §"Audio plugin discipline" in CLAUDE.md and the audioAnchorsPtr
    // member below.
    const std::vector<engine::Anchor>& getAnchors() const { return anchors; }
    void setAnchors(std::vector<engine::Anchor> value);

    // Test-only accessor for the audio-thread anchor snapshot. Asserts
    // that mutator calls (setAnchors / addAnchorAtNextStep / setStateInformation)
    // publish to the audio side. Returns by const-ref to the underlying
    // vector held by the current shared_ptr; the snapshot lives at least
    // until the next publish, so the reference is safe within the same
    // test scope.
    const std::vector<engine::Anchor>& getAudioAnchorsForTest() const;

    // Editor-facing snapshot of the current walk inputs (startChord, cells,
    // anchors, etc. flattened from APVTS). Lets the lattice view compute the
    // walk path for trail rendering without re-reading APVTS itself.
    // Message-thread only — allocates a fresh WalkState, which is fine off
    // the audio thread. The audio thread uses populateAudioWalkState
    // (no-alloc after prepareToPlay).
    engine::WalkState makeWalkStateSnapshot() const;

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

    // Triple-buffered anchor snapshot for the audio thread. SPSC: message
    // thread is the sole writer (publishAnchors), audio thread is the sole
    // reader (populateAudioWalkState). The previous design used
    // `std::atomic_load`/`std::atomic_store` on a `std::shared_ptr`, which
    // (a) is deprecated in C++20 and removed in C++26 and (b) is lock-based
    // on libc++ (`__sp_mut` is a pthread_mutex), violating CLAUDE.md
    // §"Audio plugin discipline".
    //
    // Slot rotation: each publish picks a slot that is neither the current
    // published nor the previous published — guaranteed to exist with 3
    // slots. The audio thread reads `audioAnchorPublished_` (acquire),
    // then reads `audioAnchorSnaps_[slot]`. The msg thread cannot write
    // to the slot the audio thread is currently reading because that slot
    // is excluded from the next-write pick. The theoretical race window
    // (3 publishes between audio load and read-completion) is ruled out
    // by physics: audio reads complete in microseconds, msg-thread
    // publishes are at user-input rate (≤ ~10 Hz).
    std::array<std::vector<engine::Anchor>, 3> audioAnchorSnaps_;
    std::atomic<int> audioAnchorPublished_{0};
    // Message-thread-only history. Excluded from the next write pick so
    // the audio thread's in-flight read is never overwritten.
    int prevPublishedSlot_ = -1;

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

    // Audio-thread scratch WalkState. populateAudioWalkState mutates this
    // in place each block (clear() + push_back), avoiding the per-block
    // heap allocation a by-value WalkState would incur. prepareToPlay
    // reserves capacity for cells (kCellCount) and anchors so steady-state
    // populates are no-alloc — see CLAUDE.md §"Audio plugin discipline".
    mutable engine::WalkState audioWalkState_;

    // Sub-step rhythm/arp state (mirrors m4l host.ts:140-156). The walker
    // computes a fresh chord at every cell boundary; rhythm gating decides
    // which sub-steps within the cell fire, ARP picker selects the voiced
    // index, and the turing register evolves per sub-step.
    //   currentCellEvent — chord/cellIdx/played from the most recent cell
    //                      boundary's walkStepEvent, replayed for the
    //                      sub-step refires inside the cell.
    //   fireIdxThisCell  — count of arp-active fires since the cell head.
    //                      Reset at every cell boundary EXCEPT under
    //                      legato + arp where the cycle spans cells.
    //   arpRng           — mulberry32 stream consumed by ArpMode::Random.
    //                      Reseeded from `seed` on transport restart.
    //   turingState      — register + private rng. Reseeded from
    //                      (turingLength, turingSeed) on transport restart
    //                      and on those params changing.
    //   lastTuringLength / lastTuringSeed — cached so parameterChanged can
    //                      tell when to rebuild turingState without
    //                      reseeding on every callback.
    std::optional<engine::StepEvent> currentCellEvent{};
    int                              fireIdxThisCell = 0;
    engine::Mulberry32               arpRng{0u};
    engine::TuringRhythmState        turingState = engine::makeTuringState(8, 0u);
    int                              lastSeedForArpRng = 0;
    int                              lastTuringLength = 8;
    int                              lastTuringSeed = 0;
    // Set by `parameterChanged` when stepsPerTransform changes; consumed
    // (and cleared) at the top of the next handleWalkerMidi sub-step
    // catch-up loop. Lets a RATE change take effect at the next sub-step
    // boundary rather than waiting for the old cell to finish.
    std::atomic<bool>                cellStateDirty{false};
    // Set by `parameterChanged` when turingLength / turingSeed change.
    // The actual register rebuild runs on the audio thread (drained at the
    // top of handleWalkerMidi) via engine::resetTuringState — in-place,
    // no realloc since `turingState.reg` is reserved to kTuringLengthMax
    // in the constructor. Defers the work off the message-thread parameter
    // listener path AND keeps it off any caller of parameterChanged that
    // is itself the audio thread (host automation through processBlock):
    // the rebuild is no-alloc either way, so realtime safety is preserved.
    std::atomic<bool>                turingDirty{false};
    // Set by `setStateInformation` after rewriting the live state. The
    // audio thread checks this at the top of handleWalkerMidi and runs a
    // panic + walker reset before resuming. Without it, a host that
    // restores state mid-playback (Bitwig live-replace, Logic session
    // reload during a render) would leave `held` referencing the prior
    // chord and `currentCellEvent` referencing pre-restore cells, causing
    // dangling note-ons and miscued chord changes until the next transport
    // stop.
    std::atomic<bool>                walkerPanicRequested_{false};
    // Defers `arpRng` reseed off whichever thread `parameterChanged` is
    // dispatched on. Without this, a host that writes `seed` automation
    // through processBlock would call parameterChanged on the audio
    // thread (OK in isolation), but if the host writes from the message
    // thread instead, the audio thread's `arpRng.next()` calls race
    // with the parameterChanged-driven `arpRng = Mulberry32{...}`. The
    // dirty flag funnels the reseed through the audio thread's drain at
    // the top of handleWalkerMidi — same pattern as `turingDirty`.
    std::atomic<bool>                seedDirty_{false};

    // Preview MIDI (lattice tap / long-press audition). Lock-free hand-off:
    // the editor stores `pendingPreviewChord`, then flips
    // `previewRequested` with release-store. processBlock reads the flag
    // with acquire-load and consumes the chord in the same block.
    std::atomic<bool> previewRequested{false};
    engine::Triad pendingPreviewChord{};
    double sampleRate = 44100.0;
    int previewSamplesUntilOff = 0;
    std::vector<std::pair<int, int>> previewHeld;

    // Field-by-field WalkState population shared by makeWalkStateSnapshot
    // (editor, allocates a fresh value) and populateAudioWalkState (audio
    // thread, mutates audioWalkState_ in place). Anchors are NOT touched
    // by this helper — each caller plugs them in from the appropriate
    // source (editor: `anchors` directly; audio: shared_ptr snapshot).
    void populateWalkStateCommon(engine::WalkState& w) const;

    // Audio-thread WalkState refresh. Reads anchors via atomic_load on
    // audioAnchorsPtr (lock-free). After warmup (prepareToPlay reserves
    // capacity), no heap allocation per block.
    void populateAudioWalkState();

    // Publish a fresh shared_ptr snapshot of `anchors` to audioAnchorsPtr
    // via std::atomic_store. Called from every message-thread anchors
    // mutator (setAnchors, addAnchorAtNextStep, setStateInformation).
    void publishAnchors();

    void emitPanic(juce::MidiBuffer&, int sampleOffset);
    void emitChord(juce::MidiBuffer&,
                   const engine::Triad&,
                   engine::Voicing,
                   bool seventh,
                   int channel,
                   float velocity,
                   int sampleOffset);
    void handlePreviewMidi(juce::MidiBuffer&, int blockSamples);
    void handleWalkerMidi(juce::MidiBuffer&, int blockSamples);

    // One-deep deferred fire queue for cell.timing offsets that fall past
    // the current block. Concept §Traversal: timing is 0..+0.5 of the cell
    // duration (e.g. timing=0.5 at spt=1 / 120 bpm / 44100 Hz → 2756 sample
    // delay, far past a typical 256–2048 sample block). Each pending fire
    // bundles the legato handoff offs + the new chord ons so the displaced
    // moment-in-time is atomic. `pendingFireSampleAbs_ < 0` means inactive.
    //
    // `audioBlockStartSample_` is a host-clock-agnostic running sample
    // counter incremented by `blockSamples` each processBlock; reset to 0
    // alongside any panic path (transport stop, no-playhead, backward
    // scrub) so the pending queue's absolute sample positions stay
    // coherent inside one play session.
    juce::MidiBuffer pendingMidi_;
    juce::int64      pendingFireSampleAbs_{-1};
    juce::int64      audioBlockStartSample_{0};
    // Scratch MidiBuffer for the input-filter pass at the top of
    // processBlock (drops region/keyboard notes + sysex, keeps CC etc.).
    // Pre-reserved in prepareToPlay so the per-block addEvent loop is
    // alloc-free. Without this scratch the previous pattern constructed
    // a stack-local juce::MidiBuffer every block, allocating once any
    // CC / pitch-bend / aftertouch event was present (sustain pedal
    // alone trips it on every block during a held note).
    juce::MidiBuffer keptScratch_;
    // Companion to pendingMidi_: the held set the queued fire WILL leave
    // sounding once it drains. `held` itself is left alone while pending
    // is in flight so an interim panic (transport stop, scrub) sends
    // note-offs for what is *currently sounding*, not what will sound.
    std::vector<std::pair<int, int>> pendingHeld_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OedipaProcessor)
};

}  // namespace plugin
}  // namespace oedipa
