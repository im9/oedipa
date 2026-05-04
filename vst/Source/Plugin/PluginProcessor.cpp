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

OedipaProcessor::BusesProperties OedipaProcessor::makeBusesProperties(bool addLiveStubOutput)
{
    if (! addLiveStubOutput) return BusesProperties();
    return BusesProperties().withOutput("Output", juce::AudioChannelSet::stereo(), true);
}

OedipaProcessor::OedipaProcessor()
    : AudioProcessor(makeBusesProperties(juce::PluginHostType().isAbletonLive())),
      apvts(*this, nullptr, "OedipaParams", makeParameterLayout())
{}

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

    // MIDI effect: zero audio channels, but processBlock can still receive
    // a sized buffer in some hosts. Clear it defensively.
    for (int ch = 0; ch < audio.getNumChannels(); ++ch) {
        audio.clear(ch, 0, audio.getNumSamples());
    }

    // Phase 3 contract: input MIDI is dropped. Output is purely the
    // walker — keyboard-driven startChord (ADR 004) ships in a later
    // phase. Letting the input doubled with the walker would turn
    // Oedipa into a monitor instead of a generator, defeating the
    // engine wiring under test.
    midi.clear();

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
        return;
    }

    const auto ppqOpt = position->getPpqPosition();
    if (! ppqOpt.hasValue()) {
        if (! held.empty()) emitPanic(midi, 0);
        lastSubStep = -1;
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
        // Panic + reset so the catch-up loop fires from the new pos.
        emitPanic(midi, 0);
        lastSubStep = currentSubStep - 1;
    }

    if (currentSubStep == lastSubStep) return;  // no boundaries crossed

    const auto state = makeWalkState();

    const int channel  = (int) *apvts.getRawParameterValue(pid::channel);
    const auto voicing = (engine::Voicing) (int) *apvts.getRawParameterValue(pid::voicing);
    const bool seventh = ((int) *apvts.getRawParameterValue(pid::chordQuality)) == 1;
    const float outLvl = *apvts.getRawParameterValue(pid::outputLevel);

    // Phase 3 simplification: every fired event is emitted at sample 0
    // of the current block. Sub-block timing precision (mapping a
    // sub-step's exact ppq into a sample offset within the block) is a
    // Phase 5 / 6 polish concern — typical block sizes (≤ 512 samples,
    // ≤ ~12 ms @ 44.1 kHz) are well below a 16th note at ordinary
    // tempos, so the timing offset is musically inaudible here.
    for (int step = lastSubStep + 1; step <= currentSubStep; ++step) {
        const auto ev = engine::walkStepEvent(state, step);
        if (! ev || ! ev->played) continue;
        emitChord(midi, ev->chord, voicing, seventh, channel, outLvl, /*sampleOffset=*/0);
    }

    lastSubStep = currentSubStep;
}

void OedipaProcessor::requestPreview(engine::Triad chord)
{
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
    for (const auto& s : slots) {
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

    apvts.replaceState(state);

    const auto node = state.getChildWithName(kStateTag);
    if (! node.isValid()) return;

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
        const int n = std::min((int) slots.size(), slotsNode.getNumChildren());
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
            slots[(std::size_t) i] = s;
        }
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
}

}  // namespace plugin
}  // namespace oedipa

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new oedipa::plugin::OedipaProcessor();
}
