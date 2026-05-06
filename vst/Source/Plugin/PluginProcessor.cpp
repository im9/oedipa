#include "Plugin/PluginProcessor.h"

#include "Editor/PluginEditor.h"
#include "Engine/Lattice.h"
#include "Engine/Walker.h"
#include "Plugin/Parameters.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>

#include <algorithm>
#include <cmath>
#include <cstdint>

namespace oedipa {
namespace plugin {

namespace {

// String<->Op mapping for the OedipaState ValueTree. The strings are the
// wire format inside save data; reorder-safe because Ops are looked up by
// string, not by index.
const char* opToString(engine::Op op)
{
    switch (op) {
        case engine::Op::P:    return "P";
        case engine::Op::L:    return "L";
        case engine::Op::R:    return "R";
        case engine::Op::Hold: return "hold";
        case engine::Op::Rest: return "rest";
    }
    return "hold";
}

engine::Op opFromString(const juce::String& s)
{
    if (s == "P")    return engine::Op::P;
    if (s == "L")    return engine::Op::L;
    if (s == "R")    return engine::Op::R;
    if (s == "rest") return engine::Op::Rest;
    return engine::Op::Hold;
}

const char* qualityToString(engine::Quality q)
{
    return q == engine::Quality::Major ? "major" : "minor";
}

engine::Quality qualityFromString(const juce::String& s)
{
    return s == "minor" ? engine::Quality::Minor : engine::Quality::Major;
}

constexpr const char* kStateTag      = "OedipaState";
constexpr const char* kStartChordTag = "StartChord";
constexpr const char* kCellsTag      = "Cells";
constexpr const char* kCellTag       = "Cell";
constexpr const char* kSlotsTag      = "Slots";
constexpr const char* kSlotTag       = "Slot";
constexpr const char* kAnchorsTag    = "Anchors";
constexpr const char* kAnchorTag     = "Anchor";

}  // namespace

OedipaProcessor::OedipaProcessor()
    : AudioProcessor(BusesProperties()),
      apvts(*this, nullptr, "OedipaParams", makeParameterLayout())
{
    // Default program: P, L, R, Hold (the canonical "Mixed" preset shape).
    // Walker.cpp treats Hold as no-attack (played=false), so an all-Hold
    // default — which is what `Cell{}` defaults give — produces silence on
    // a fresh insert. P/L/R on cells[0..2] guarantees the first transform
    // boundary fires an audible chord change.
    cells[0].op = engine::Op::P;
    cells[1].op = engine::Op::L;
    cells[2].op = engine::Op::R;
    // Sync slot 0 so the bank reflects what live state is. Without this,
    // switching to slot 1 and back would land on an all-Hold slot 0.
    bank.syncActive(captureSlot());

    // ADR 008 Phase 5 — auto-save on APVTS-tracked slot fields. cells and
    // startChord are routed through their own setters; jitter/seed/length
    // need a listener because the editor + tests mutate them via the
    // parameter API directly.
    apvts.addParameterListener(pid::jitter,            this);
    apvts.addParameterListener(pid::seed,              this);
    apvts.addParameterListener(pid::length,            this);
    apvts.addParameterListener(pid::turingLength,      this);
    apvts.addParameterListener(pid::turingSeed,        this);
    apvts.addParameterListener(pid::stepsPerTransform, this);

    // Seed the rhythm/arp state from the initial APVTS values so a fresh
    // processor has a deterministic stochastic stream from the first
    // processBlock — same contract as walkStepEvent's seed.
    const int seed0 = (int) *apvts.getRawParameterValue(pid::seed);
    const int tLen0 = (int) *apvts.getRawParameterValue(pid::turingLength);
    const int tSed0 = (int) *apvts.getRawParameterValue(pid::turingSeed);
    arpRng            = engine::Mulberry32{(std::uint32_t) seed0};
    lastSeedForArpRng = seed0;
    turingState       = engine::makeTuringState(tLen0, (std::uint32_t) tSed0);
    lastTuringLength  = tLen0;
    lastTuringSeed    = tSed0;
}

OedipaProcessor::~OedipaProcessor()
{
    apvts.removeParameterListener(pid::jitter,            this);
    apvts.removeParameterListener(pid::seed,              this);
    apvts.removeParameterListener(pid::length,            this);
    apvts.removeParameterListener(pid::turingLength,      this);
    apvts.removeParameterListener(pid::turingSeed,        this);
    apvts.removeParameterListener(pid::stepsPerTransform, this);
}

void OedipaProcessor::setStartChord(engine::Triad value)
{
    startChord = value;
    syncActiveSlot();
}

void OedipaProcessor::setCell(int idx, const engine::Cell& cell)
{
    cells.at(static_cast<std::size_t>(idx)) = cell;
    syncActiveSlot();
}

void OedipaProcessor::setCellField(int idx, engine::CellField field, float value)
{
    if (idx < 0 || idx >= kCellCount) return;
    if (std::isnan(value)) return;
    auto& cell = cells[static_cast<std::size_t>(idx)];
    switch (field) {
        case engine::CellField::Velocity:    cell.velocity    = value; break;
        case engine::CellField::Gate:        cell.gate        = value; break;
        case engine::CellField::Probability: cell.probability = value; break;
        case engine::CellField::Timing:      cell.timing      = value; break;
    }
}

engine::Slot OedipaProcessor::captureSlot() const
{
    engine::Slot s{};
    for (std::size_t i = 0; i < cells.size() && i < s.ops.size(); ++i) {
        s.ops[i] = cells[i].op;
    }
    const auto id = engine::identifyTriad(startChord);
    s.startRootPc  = id.rootPc;
    s.startQuality = id.quality;
    s.jitter = *apvts.getRawParameterValue(pid::jitter);
    s.seed   = static_cast<std::uint32_t>(static_cast<int>(*apvts.getRawParameterValue(pid::seed)));
    return s;
}

void OedipaProcessor::applySlot(const engine::Slot& slot)
{
    suppressAutoSave = true;

    for (std::size_t i = 0; i < cells.size() && i < slot.ops.size(); ++i) {
        cells[i].op = slot.ops[i];
    }
    // Rebuild startChord at the current octave (root MIDI note as reference)
    // — preserves register across slot switches per m4l ADR 006 §"Axis 1".
    startChord = engine::buildTriad(slot.startRootPc, slot.startQuality, startChord[0]);

    // Write jitter/seed via the parameter API. Each assignment fires the
    // listener; suppressAutoSave makes those callbacks no-ops so the slot
    // stays the source of truth, not a partial-mid-apply capture.
    if (auto* jp = apvts.getParameter(pid::jitter)) {
        *static_cast<juce::AudioParameterFloat*>(jp) = slot.jitter;
    }
    if (auto* sp = apvts.getParameter(pid::seed)) {
        *static_cast<juce::AudioParameterInt*>(sp) = static_cast<int>(slot.seed);
    }

    suppressAutoSave = false;
    // Pin the bank to the exact slot the caller passed in, in case the
    // listener fired during the brief unsuppressed window between writes.
    bank.syncActive(slot);
}

void OedipaProcessor::switchSlot(int idx)
{
    if (idx < 0 || idx >= engine::kSlotCount) return;
    bank.switchTo(idx);
    applySlot(bank.activeSlot());
}

void OedipaProcessor::syncActiveSlot()
{
    if (suppressAutoSave) return;
    bank.syncActive(captureSlot());
}

void OedipaProcessor::parameterChanged(const juce::String& parameterID, float)
{
    if (parameterID == pid::jitter || parameterID == pid::seed || parameterID == pid::length) {
        syncActiveSlot();
    }
    // Seed change reseeds the ARP rng so the random-arp stream tracks the
    // user-visible seed. Same contract m4l host.ts:179-181 enforces.
    if (parameterID == pid::seed) {
        const int seedNow = (int) *apvts.getRawParameterValue(pid::seed);
        if (seedNow != lastSeedForArpRng) {
            arpRng = engine::Mulberry32{(std::uint32_t) seedNow};
            lastSeedForArpRng = seedNow;
        }
    }
    // Turing register init is a function of (length, seed); rebuild on any
    // change. Lock is read live in turingFires, no rebuild needed.
    if (parameterID == pid::turingLength || parameterID == pid::turingSeed) {
        const int tLen = (int) *apvts.getRawParameterValue(pid::turingLength);
        const int tSed = (int) *apvts.getRawParameterValue(pid::turingSeed);
        if (tLen != lastTuringLength || tSed != lastTuringSeed) {
            turingState = engine::makeTuringState(tLen, (std::uint32_t) tSed);
            lastTuringLength = tLen;
            lastTuringSeed   = tSed;
        }
    }
    // RATE change: invalidate the cached cell event so the next sub-step
    // re-pulls a fresh chord from the walker at the new spt boundary.
    // Without this, the walker keeps replaying the previously-cached
    // cell until the OLD (stale-spt) boundary lands, which is what the
    // user perceives as "RATE doesn't take effect immediately".
    if (parameterID == pid::stepsPerTransform) {
        cellStateDirty.store(true, std::memory_order_release);
    }
}

void OedipaProcessor::prepareToPlay(double newSampleRate, int)
{
    // A fresh prepareToPlay marks a new transport context; clear any
    // stale walker state so the next processBlock starts from pos 0.
    lastSubStep = -1;
    held.clear();

    // Sample rate is captured for the preview release timing only — walker
    // emission stays sample-rate agnostic (it works in ppq from the
    // playhead). Preview length is musical-time (300 ms) so it needs sr.
    sampleRate = newSampleRate;
    // Drain any in-flight preview held notes; they're stale if the host
    // is restarting the transport graph.
    previewHeld.clear();
    previewSamplesUntilOff = 0;
}

void OedipaProcessor::releaseResources() {}

engine::WalkState OedipaProcessor::makeWalkState() const
{
    engine::WalkState w;
    w.startChord = startChord;
    w.stepsPerTransform = (int) *apvts.getRawParameterValue(pid::stepsPerTransform);
    w.jitter = *apvts.getRawParameterValue(pid::jitter);
    w.seed = (std::uint32_t) (int) *apvts.getRawParameterValue(pid::seed);
    w.stepDirection = (engine::StepDirection) (int) *apvts.getRawParameterValue(pid::stepDirection);

    // Active cell count = `length` parameter (1..8). Trailing cells are
    // ignored by the walker — matches m4l Phase 7 cell-length semantics.
    const int len = std::clamp((int) *apvts.getRawParameterValue(pid::length), 1, kCellCount);
    w.cells.reserve((std::size_t) len);
    for (int i = 0; i < len; ++i) w.cells.push_back(cells[(std::size_t) i]);

    w.anchors = anchors;
    return w;
}

void OedipaProcessor::emitPanic(juce::MidiBuffer& midi, int sampleOffset)
{
    for (const auto& [ch, note] : held) {
        midi.addEvent(juce::MidiMessage::noteOff(ch, note), sampleOffset);
    }
    held.clear();
}

void OedipaProcessor::emitChord(juce::MidiBuffer& midi,
                                 const engine::Triad& chord,
                                 engine::Voicing voicing,
                                 bool seventh,
                                 int channel,
                                 float velocity,
                                 int sampleOffset)
{
    // Note-off the previous chord at the same sample offset so the
    // crossfade between attacks is host-deterministic. Then layer the
    // new chord's note-ons on top.
    emitPanic(midi, sampleOffset);

    auto voiced = engine::applyVoicing(chord, voicing);
    if (seventh) {
        const auto id = engine::identifyTriad(chord);
        voiced = engine::addSeventh(voiced, id.quality);
    }

    const auto vel = (juce::uint8) std::clamp((int) std::round(velocity * 127.0f), 1, 127);
    for (int note : voiced) {
        const int clamped = std::clamp(note, 0, 127);
        midi.addEvent(juce::MidiMessage::noteOn(channel, clamped, vel), sampleOffset);
        held.emplace_back(channel, clamped);
    }
}

void OedipaProcessor::processBlock(juce::AudioBuffer<float>& audio, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;

    // MIDI effect: do NOT clear `audio`. Even though `IS_MIDI_EFFECT TRUE`
    // means the host should pass zero audio channels, some hosts (Logic
    // among them) defensively hand us a buffer with channels carrying
    // residual samples — clearing those to zero introduces a sample-step
    // discontinuity that the downstream synth path renders as a click on
    // transport-start (and at any sub-step where we'd otherwise be
    // silent under e.g. rhythm='offbeat'). User report 2026-05-06.
    // The buffer is left untouched; we only emit MIDI.
    juce::ignoreUnused(audio);

    // Drop region / keyboard NOTES so the walker is the sole note source
    // (ADR 004 keyboard-driven startChord ships later — letting region
    // notes through doubles them with the walker). But keep every
    // non-note message (CC, sustain pedal, pitch-bend, channel pressure,
    // system messages) so the downstream synth still sees the host's
    // transport / sustain / state-init signals. A blanket midi.clear()
    // wiped Logic's transport-start sync messages and produced an
    // audible click at play start (user report 2026-05-06): the synth
    // started attacking notes from a state Logic expected to have
    // initialised via those messages.
    {
        juce::MidiBuffer kept;
        for (const auto meta : midi) {
            const auto m = meta.getMessage();
            if (m.isNoteOn() || m.isNoteOff()) continue;
            kept.addEvent(m, meta.samplePosition);
        }
        midi.swapWith(kept);
    }

    handlePreviewMidi(midi, audio.getNumSamples());
    handleWalkerMidi(midi);
}

void OedipaProcessor::handlePreviewMidi(juce::MidiBuffer& midi, int blockSamples)
{
    // Lattice tap / long-press auditions a chord. Preview runs independently
    // of the host transport — the user is exploring even when stopped — so
    // this lives outside the playhead-gated walker logic below.
    const int channel = (int) *apvts.getRawParameterValue(pid::channel);

    if (previewRequested.exchange(false, std::memory_order_acquire)) {
        // Cancel any in-flight preview so back-to-back taps don't stack.
        if (! previewHeld.empty()) {
            for (auto& [ch, n] : previewHeld) {
                midi.addEvent(juce::MidiMessage::noteOff(ch, n), 0);
            }
            previewHeld.clear();
        }

        // Inboil's preview velocity is 0.6; map to MIDI 76. Voicing /
        // 7th extension intentionally not applied — the preview is the
        // raw triad the user pointed at, no sequence logic.
        constexpr juce::uint8 previewVel = 76;
        for (int n : pendingPreviewChord) {
            const int clamped = std::clamp(n, 0, 127);
            midi.addEvent(juce::MidiMessage::noteOn(channel, clamped, previewVel), 0);
            previewHeld.emplace_back(channel, clamped);
        }
        // Inboil PREVIEW_MS = 300.
        previewSamplesUntilOff = (int) std::round(sampleRate * 0.3);
    }

    if (previewSamplesUntilOff > 0 && ! previewHeld.empty()) {
        if (previewSamplesUntilOff <= blockSamples) {
            const int offset = std::clamp(previewSamplesUntilOff - 1, 0, blockSamples - 1);
            for (auto& [ch, n] : previewHeld) {
                midi.addEvent(juce::MidiMessage::noteOff(ch, n), offset);
            }
            previewHeld.clear();
            previewSamplesUntilOff = 0;
        } else {
            previewSamplesUntilOff -= blockSamples;
        }
    }
}

void OedipaProcessor::handleWalkerMidi(juce::MidiBuffer& midi)
{
    auto* playHead = getPlayHead();
    auto position = (playHead != nullptr) ? playHead->getPosition() : juce::Optional<juce::AudioPlayHead::PositionInfo>{};

    const bool isPlaying = position.hasValue() && position->getIsPlaying();
    if (! isPlaying) {
        // Transport stopped (or no playhead at all in some standalone /
        // offline render contexts): drain held output notes so the host
        // doesn't see dangling MIDI, then idle.
        if (! held.empty()) emitPanic(midi, 0);
        lastSubStep = -1;
        // Clear sub-step state so the next start re-runs the init path.
        currentCellEvent.reset();
        fireIdxThisCell = 0;
        return;
    }

    const auto ppqOpt = position->getPpqPosition();
    if (! ppqOpt.hasValue()) {
        if (! held.empty()) emitPanic(midi, 0);
        lastSubStep = -1;
        currentCellEvent.reset();
        fireIdxThisCell = 0;
        return;
    }

    // Sub-step grid is sixteenth notes (4 per quarter), matching m4l's
    // ticksPerStep convention so the test vectors apply unchanged.
    const double ppq = std::max(0.0, *ppqOpt);
    const int currentSubStep = (int) std::floor(ppq * 4.0);

    if (currentSubStep < lastSubStep) {
        // Backward jump (loop wrap or user scrub): the walker's PRNG-fresh
        // contract still computes correct chords at the new pos, but any
        // notes held from before would dangle until the next attack.
        // Panic + reset rhythm/arp/turing state so the catch-up loop fires
        // from the new pos with a fresh stochastic stream (matches m4l's
        // pendingPosReset path in host.ts:435-446).
        emitPanic(midi, 0);
        lastSubStep = currentSubStep - 1;
        currentCellEvent.reset();
        fireIdxThisCell = 0;
        const int seedNow = (int) *apvts.getRawParameterValue(pid::seed);
        arpRng = engine::Mulberry32{(std::uint32_t) seedNow};
        turingState = engine::makeTuringState(lastTuringLength, (std::uint32_t) lastTuringSeed);
    }

    // Honour a RATE change made via parameterChanged: drop the cached
    // cell event so the next boundary picks up the new spt.
    if (cellStateDirty.exchange(false, std::memory_order_acquire)) {
        currentCellEvent.reset();
        fireIdxThisCell = 0;
    }

    if (currentSubStep == lastSubStep) return;  // no boundaries crossed

    const auto state    = makeWalkState();
    const int  channel  = (int) *apvts.getRawParameterValue(pid::channel);
    const auto voicing  = (engine::Voicing) (int) *apvts.getRawParameterValue(pid::voicing);
    const bool seventh  = ((int) *apvts.getRawParameterValue(pid::chordQuality)) == 1;
    const float outLvl  = *apvts.getRawParameterValue(pid::outputLevel);
    const int  spt      = std::max(1, (int) *apvts.getRawParameterValue(pid::stepsPerTransform));
    const auto rhythm   = (engine::RhythmPreset) (int) *apvts.getRawParameterValue(pid::rhythm);
    const auto arp      = (engine::ArpMode)      (int) *apvts.getRawParameterValue(pid::arp);
    const float tLock   = *apvts.getRawParameterValue(pid::turingLock);

    for (int step = lastSubStep + 1; step <= currentSubStep; ++step) {
        // Init synthetic event at step==0 — same shape as m4l's pos=0 path
        // (host.ts:471-484): startChord with cellIdx=-1, played=true, used
        // for the head fire and any sub-step refires before pos>=spt.
        if (step == 0) {
            engine::StepEvent init{};
            init.cellIdx    = -1;
            init.resolvedOp = engine::Op::Hold;
            init.chord      = startChord;
            init.played     = true;
            currentCellEvent = init;
            fireIdxThisCell  = 0;
        } else if ((step % spt) == 0) {
            // Cell boundary at step >= spt: pull a fresh event from the
            // walker for the cell that just ended.
            currentCellEvent = engine::walkStepEvent(state, step);
            fireIdxThisCell  = 0;
        }

        if (! currentCellEvent) continue;

        const int subStepIdxInCell = step % spt;

        // Rhythm gate decides whether this sub-step fires. Three branches:
        //   - Turing: stateful register advances every sub-step (the call
        //     mutates turingState whether or not we end up firing).
        //   - Legato + ARP active: override head-only gating to fire every
        //     sub-step, so the held chord audibly arpeggiates.
        //   - Stateless gating predicate per preset.
        bool fires;
        if (rhythm == engine::RhythmPreset::Turing) {
            fires = engine::turingFires(turingState, tLock);
        } else if (rhythm == engine::RhythmPreset::Legato && arp != engine::ArpMode::Off) {
            fires = true;
        } else {
            fires = engine::gatingFires(rhythm, subStepIdxInCell);
        }
        if (! fires || ! currentCellEvent->played) continue;

        // Per-cell expression. cells[ev->cellIdx] is the source of truth
        // for vel/gate/prob/timing; for the init synthetic event the
        // cellIdx is -1, fall back to defaults (gate=1.0, vel=1.0).
        const int  cIdx = currentCellEvent->cellIdx;
        const bool isInit = cIdx < 0;
        const float cellVel = isInit ? 1.0f : cells[(std::size_t) cIdx].velocity;

        auto voiced = engine::applyVoicing(currentCellEvent->chord, voicing);
        if (seventh) {
            const auto id = engine::identifyTriad(currentCellEvent->chord);
            voiced = engine::addSeventh(voiced, id.quality);
        }

        // ARP picker: nullopt = full chord, otherwise pick a single voiced
        // index. fireIdxThisCell only advances on actual fires — cells
        // gated to silence don't tick the arp cycle.
        const auto pickIdx = engine::arpIndex(arp, (int) voiced.size(),
                                              fireIdxThisCell, arpRng);

        const float velNorm = std::clamp(cellVel * outLvl, 0.0f, 1.0f);
        const auto vel = (juce::uint8) std::clamp((int) std::round(velNorm * 127.0f), 1, 127);

        // Emit handoff note-offs first (legato handoff: prior notes off at
        // the same sample offset as the new noteOns).
        for (const auto& [ch, note] : held) {
            midi.addEvent(juce::MidiMessage::noteOff(ch, note), 0);
        }
        held.clear();

        if (pickIdx) {
            const int n = std::clamp(voiced[(std::size_t) *pickIdx], 0, 127);
            midi.addEvent(juce::MidiMessage::noteOn(channel, n, vel), 0);
            held.emplace_back(channel, n);
        } else {
            for (int n : voiced) {
                const int clamped = std::clamp(n, 0, 127);
                midi.addEvent(juce::MidiMessage::noteOn(channel, clamped, vel), 0);
                held.emplace_back(channel, clamped);
            }
        }
        ++fireIdxThisCell;
    }

    lastSubStep = currentSubStep;
}

void OedipaProcessor::requestPreview(engine::Triad chord)
{
    // Suppress the lattice-tap / long-press preview while the transport is
    // playing — the audition note collides with the walker's output and
    // reads as noise during a take. -1 = transport stopped (no chord
    // currently emitting), so previewing is OK in that state.
    if (lastSubStep.load(std::memory_order_acquire) >= 0) return;
    pendingPreviewChord = chord;
    previewRequested.store(true, std::memory_order_release);
}

void OedipaProcessor::applyDragResolution(engine::Triad newStartChord,
                                           const std::vector<engine::Transform>& ops)
{
    // Inboil bails when ops is empty (drag was non-resolvable from start).
    // Match: leave both startChord and cells untouched.
    if (ops.empty()) return;

    startChord = newStartChord;

    // Overwrite the leading cells with the resolved transforms; trailing
    // cells stay (m4l Phase 7 cell-length semantics — dormant cells exist
    // and reappear if the user expands `length` later).
    const int n = std::min((int) ops.size(), kCellCount);
    for (int i = 0; i < n; ++i) {
        engine::Op op;
        switch (ops[(std::size_t) i]) {
            case engine::Transform::P: op = engine::Op::P; break;
            case engine::Transform::L: op = engine::Op::L; break;
            case engine::Transform::R: op = engine::Op::R; break;
        }
        cells[(std::size_t) i].op = op;
    }

    // Length follows ops.size(), clamped to [1, kCellCount]. APVTS write
    // notifies host listeners (automation, undo).
    if (auto* lenParam = apvts.getParameter(pid::length)) {
        const auto& range = lenParam->getNormalisableRange();
        const float v = range.convertTo0to1((float) std::clamp(n, 1, kCellCount));
        lenParam->setValueNotifyingHost(v);
    }
}

void OedipaProcessor::addAnchorAtNextStep(engine::PitchClass rootPc, engine::Quality quality)
{
    const int spt = std::max(1, (int) *apvts.getRawParameterValue(pid::stepsPerTransform));

    int lastStep = 0;
    for (const auto& a : anchors) {
        if (a.step > lastStep) lastStep = a.step;
    }
    const int newStep = lastStep + spt * 4;

    anchors.push_back(engine::Anchor{newStep, rootPc, quality});

    // Long-press also auditions the anchored chord (per inboil).
    requestPreview(engine::buildTriad(rootPc, quality, startChord[0]));
}

juce::AudioProcessorEditor* OedipaProcessor::createEditor()
{
    return new editor::OedipaEditor(*this);
}

void OedipaProcessor::getStateInformation(juce::MemoryBlock& destData)
{
    auto state = apvts.copyState();

    // Replace any prior OedipaState child so we don't accumulate stale
    // copies across save calls.
    state.removeChild(state.getChildWithName(kStateTag), nullptr);

    juce::ValueTree node{kStateTag};
    node.setProperty("version", kStateVersion, nullptr);

    juce::ValueTree sc{kStartChordTag};
    sc.setProperty("root",  startChord[0], nullptr);
    sc.setProperty("third", startChord[1], nullptr);
    sc.setProperty("fifth", startChord[2], nullptr);
    node.appendChild(sc, nullptr);

    juce::ValueTree cellsNode{kCellsTag};
    for (const auto& c : cells) {
        juce::ValueTree cellNode{kCellTag};
        cellNode.setProperty("op",          juce::String(opToString(c.op)), nullptr);
        cellNode.setProperty("velocity",    c.velocity, nullptr);
        cellNode.setProperty("gate",        c.gate, nullptr);
        cellNode.setProperty("probability", c.probability, nullptr);
        cellNode.setProperty("timing",      c.timing, nullptr);
        cellsNode.appendChild(cellNode, nullptr);
    }
    node.appendChild(cellsNode, nullptr);

    juce::ValueTree slotsNode{kSlotsTag};
    slotsNode.setProperty("activeIndex", bank.activeIndex(), nullptr);
    for (int i = 0; i < engine::kSlotCount; ++i) {
        const auto& s = bank.slotAt(i);
        juce::ValueTree slotNode{kSlotTag};
        juce::String opsStr;
        for (auto op : s.ops) opsStr += juce::String(opToString(op)) + ",";
        slotNode.setProperty("ops",          opsStr, nullptr);
        slotNode.setProperty("startRootPc",  s.startRootPc, nullptr);
        slotNode.setProperty("startQuality", juce::String(qualityToString(s.startQuality)), nullptr);
        slotNode.setProperty("jitter",       s.jitter, nullptr);
        slotNode.setProperty("seed",         (juce::int64) s.seed, nullptr);
        slotsNode.appendChild(slotNode, nullptr);
    }
    node.appendChild(slotsNode, nullptr);

    juce::ValueTree anchorsNode{kAnchorsTag};
    for (const auto& a : anchors) {
        juce::ValueTree anchorNode{kAnchorTag};
        anchorNode.setProperty("step",    a.step, nullptr);
        anchorNode.setProperty("rootPc",  a.rootPc, nullptr);
        anchorNode.setProperty("quality", juce::String(qualityToString(a.quality)), nullptr);
        anchorsNode.appendChild(anchorNode, nullptr);
    }
    node.appendChild(anchorsNode, nullptr);

    state.appendChild(node, nullptr);

    if (auto xml = state.createXml()) {
        copyXmlToBinary(*xml, destData);
    }
}

void OedipaProcessor::setStateInformation(const void* data, int sizeInBytes)
{
    auto xml = getXmlFromBinary(data, sizeInBytes);
    if (xml == nullptr) return;

    auto state = juce::ValueTree::fromXml(*xml);
    if (! state.isValid() || state.getType() != apvts.state.getType()) return;

    // apvts.replaceState fires parameterChanged for every restored value,
    // which would otherwise auto-save the just-restored state into slot 0
    // and clobber the bank we are about to rehydrate. Suppress for the
    // duration of state restoration; the bank's saved activeIndex is the
    // source of truth for the restored session.
    suppressAutoSave = true;
    apvts.replaceState(state);

    const auto node = state.getChildWithName(kStateTag);
    if (! node.isValid()) {
        suppressAutoSave = false;
        return;
    }

    if (auto sc = node.getChildWithName(kStartChordTag); sc.isValid()) {
        startChord[0] = (int) sc.getProperty("root",  startChord[0]);
        startChord[1] = (int) sc.getProperty("third", startChord[1]);
        startChord[2] = (int) sc.getProperty("fifth", startChord[2]);
    }

    if (auto cellsNode = node.getChildWithName(kCellsTag); cellsNode.isValid()) {
        const int n = std::min((int) cells.size(), cellsNode.getNumChildren());
        for (int i = 0; i < n; ++i) {
            const auto cn = cellsNode.getChild(i);
            engine::Cell c;
            c.op          = opFromString(cn.getProperty("op"));
            c.velocity    = (float) cn.getProperty("velocity",    c.velocity);
            c.gate        = (float) cn.getProperty("gate",        c.gate);
            c.probability = (float) cn.getProperty("probability", c.probability);
            c.timing      = (float) cn.getProperty("timing",      c.timing);
            cells[(std::size_t) i] = c;
        }
    }

    if (auto slotsNode = node.getChildWithName(kSlotsTag); slotsNode.isValid()) {
        const int n = std::min(engine::kSlotCount, slotsNode.getNumChildren());
        for (int i = 0; i < n; ++i) {
            const auto sn = slotsNode.getChild(i);
            engine::Slot s;
            const auto opsStr = sn.getProperty("ops").toString();
            const auto tokens = juce::StringArray::fromTokens(opsStr, ",", "");
            for (std::size_t j = 0; j < s.ops.size(); ++j) {
                if ((int) j < tokens.size() && tokens[(int) j].isNotEmpty()) {
                    s.ops[j] = opFromString(tokens[(int) j]);
                }
            }
            s.startRootPc  = (int) sn.getProperty("startRootPc",  s.startRootPc);
            s.startQuality = qualityFromString(sn.getProperty("startQuality").toString());
            s.jitter       = (float) sn.getProperty("jitter",     s.jitter);
            s.seed         = (std::uint32_t) (juce::int64) sn.getProperty("seed", (juce::int64) s.seed);
            bank.setSlot(i, s);
        }
        // Restore active slot index. Apply via switchTo (no applySlot —
        // live params/cells were already restored above; calling applySlot
        // here would just re-write what's already there).
        const int activeIdx = (int) slotsNode.getProperty("activeIndex", 0);
        bank.switchTo(activeIdx);
    }

    anchors.clear();
    if (auto anchorsNode = node.getChildWithName(kAnchorsTag); anchorsNode.isValid()) {
        anchors.reserve((std::size_t) anchorsNode.getNumChildren());
        for (int i = 0; i < anchorsNode.getNumChildren(); ++i) {
            const auto an = anchorsNode.getChild(i);
            engine::Anchor a;
            a.step    = (int) an.getProperty("step",   a.step);
            a.rootPc  = (int) an.getProperty("rootPc", a.rootPc);
            a.quality = qualityFromString(an.getProperty("quality").toString());
            anchors.push_back(a);
        }
    }

    suppressAutoSave = false;
}

}  // namespace plugin
}  // namespace oedipa

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new oedipa::plugin::OedipaProcessor();
}
