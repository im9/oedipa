// Plugin-level tests for ADR 008 Phases 2 + 3.
//
// Concerns covered:
//   1. APVTS layout — every parameter from m4l HostParams is present with
//      the right type, range, default, and choice ordering. Choice ordering
//      is the wire format, so any reorder breaks saved presets.
//   2. State round-trip — getStateInformation → setStateInformation on a
//      fresh instance reproduces every APVTS param + every non-APVTS field
//      (cells, slots, anchors, startChord) and stamps version=1 on the
//      OedipaState child.
//   3. Bus layout — pure MIDI fx with no audio buses (regression guard
//      against re-introducing the instrument-disguise topology that ADR
//      009 §Revised 2026-05-08 rolled back).
//   4. Phase 3 input contract — input MIDI is dropped (Phase 3 doesn't
//      wire ADR 004 yet; passing input through would defeat the engine
//      test and turn the device into a monitor).
//   5. Phase 3 walker firing — with a fake playhead, processBlock emits
//      a chord at every transform boundary the playhead has crossed.
//      Held-note bookkeeping, transport stop, and backward scrub trigger
//      panic note-offs.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include "Engine/State.h"
#include "Engine/Tonnetz.h"
#include "Plugin/Parameters.h"
#include "Plugin/PluginProcessor.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>

#include <algorithm>
#include <set>
#include <vector>

using namespace oedipa::engine;
using namespace oedipa::plugin;

namespace {

template <typename T>
T* paramAs(juce::AudioProcessorValueTreeState& apvts, const char* id)
{
    auto* p = dynamic_cast<T*>(apvts.getParameter(id));
    REQUIRE(p != nullptr);
    return p;
}

}  // namespace

TEST_CASE("APVTS layout — m4l parity parameters present with correct types & defaults", "[plugin][apvts]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();

    SECTION("numeric / int params") {
        // stepsPerTransform: int 1..64, default 4
        auto* spt = dynamic_cast<juce::AudioParameterInt*>(apvts.getParameter(pid::stepsPerTransform));
        REQUIRE(spt != nullptr);
        // m4l semantics: 1 sub-step = 1 fire; 4 = quarter note at 16th grid.
        // Range 1..64 matches m4l (bridge.ts:233) and inboil's RATE slider —
        // covers single-16th up to 4-bar transforms.
        CHECK(spt->getRange().getStart() == 1);
        CHECK(spt->getRange().getEnd() == 64);
        CHECK((int)*apvts.getRawParameterValue(pid::stepsPerTransform) == defaults::stepsPerTransform);

        // jitter: float 0..1, default 0
        auto* jit = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(pid::jitter));
        REQUIRE(jit != nullptr);
        // ADR 005 jitter spec: 0..1 (probability of injecting random Tonnetz step).
        CHECK(jit->range.start == 0.0f);
        CHECK(jit->range.end == 1.0f);
        CHECK(*apvts.getRawParameterValue(pid::jitter) == defaults::jitter);

        // seed: int (uint32 in m4l, but APVTS int is signed 32-bit so we
        // expose 0..INT32_MAX; the high bit is musically irrelevant).
        auto* sd = dynamic_cast<juce::AudioParameterInt*>(apvts.getParameter(pid::seed));
        REQUIRE(sd != nullptr);
        CHECK(sd->getRange().getStart() == 0);
        // Upper bound = INT32_MAX (= 2^31 - 1). Larger seeds in m4l were
        // uint32; APVTS int caps at signed-int range. Musically a 31-bit
        // seed space is indistinguishable from 32-bit (mulberry32 mixes).
        CHECK(sd->getRange().getEnd() == 2147483647);

        // channel: int 1..16 (output MIDI channel)
        auto* ch = dynamic_cast<juce::AudioParameterInt*>(apvts.getParameter(pid::channel));
        REQUIRE(ch != nullptr);
        CHECK(ch->getRange().getStart() == 1);
        CHECK(ch->getRange().getEnd() == 16);
        CHECK((int)*apvts.getRawParameterValue(pid::channel) == defaults::channel);

        // inputChannel: int 0..16 (0 = omni, per ADR 004)
        auto* ich = dynamic_cast<juce::AudioParameterInt*>(apvts.getParameter(pid::inputChannel));
        REQUIRE(ich != nullptr);
        CHECK(ich->getRange().getStart() == 0);
        CHECK(ich->getRange().getEnd() == 16);

        // outputLevel: float 0..1, default 1
        auto* ol = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(pid::outputLevel));
        REQUIRE(ol != nullptr);
        CHECK(ol->range.start == 0.0f);
        CHECK(ol->range.end == 1.0f);
        CHECK(*apvts.getRawParameterValue(pid::outputLevel) == defaults::outputLevel);

        // length: int 1..8 (active cell count, per ADR 006 Phase 7)
        auto* ln = dynamic_cast<juce::AudioParameterInt*>(apvts.getParameter(pid::length));
        REQUIRE(ln != nullptr);
        CHECK(ln->getRange().getStart() == 1);
        CHECK(ln->getRange().getEnd() == 8);

        // turingLength: int 2..32 (per ADR 006 Phase 7 Step 4 rev 2)
        auto* tl = dynamic_cast<juce::AudioParameterInt*>(apvts.getParameter(pid::turingLength));
        REQUIRE(tl != nullptr);
        CHECK(tl->getRange().getStart() == 2);
        CHECK(tl->getRange().getEnd() == 32);

        // turingLock: float 0..1, default 0.7 (inboil default)
        auto* tlk = dynamic_cast<juce::AudioParameterFloat*>(apvts.getParameter(pid::turingLock));
        REQUIRE(tlk != nullptr);
        CHECK(tlk->range.start == 0.0f);
        CHECK(tlk->range.end == 1.0f);
        CHECK_THAT(*apvts.getRawParameterValue(pid::turingLock),
                   Catch::Matchers::WithinAbs(defaults::turingLock, 1e-6f));

        // turingSeed: same shape as seed
        auto* tsd = dynamic_cast<juce::AudioParameterInt*>(apvts.getParameter(pid::turingSeed));
        REQUIRE(tsd != nullptr);
        CHECK(tsd->getRange().getStart() == 0);
    }

    SECTION("choice params with locked string ordering (wire format)") {
        // Choice index is what APVTS persists; reordering breaks saved
        // presets. These assertions pin the wire format.

        auto* v = dynamic_cast<juce::AudioParameterChoice*>(apvts.getParameter(pid::voicing));
        REQUIRE(v != nullptr);
        CHECK(v->choices == voicingChoices);
        CHECK(v->choices.size() == 3);

        auto* cq = dynamic_cast<juce::AudioParameterChoice*>(apvts.getParameter(pid::chordQuality));
        REQUIRE(cq != nullptr);
        // ADR 008 intentional divergence from m4l (`seventh: bool`).
        // First choice = "triad" mirrors m4l's seventh=false default.
        CHECK(cq->choices == juce::StringArray{"triad", "7th"});

        auto* tm = dynamic_cast<juce::AudioParameterChoice*>(apvts.getParameter(pid::triggerMode));
        REQUIRE(tm != nullptr);
        // ADR 004: 0 = hybrid (default), 1 = hold-to-play.
        CHECK(tm->choices == juce::StringArray{"hybrid", "hold"});

        auto* sd = dynamic_cast<juce::AudioParameterChoice*>(apvts.getParameter(pid::stepDirection));
        REQUIRE(sd != nullptr);
        CHECK(sd->choices == juce::StringArray{"forward", "reverse", "pingpong", "random"});

        auto* r = dynamic_cast<juce::AudioParameterChoice*>(apvts.getParameter(pid::rhythm));
        REQUIRE(r != nullptr);
        // ADR 006 Phase 7 Step 4 rev 2: ported from inboil's TonnetzRhythm subset.
        CHECK(r->choices == juce::StringArray{"all", "legato", "onbeat", "offbeat", "syncopated", "turing"});

        auto* a = dynamic_cast<juce::AudioParameterChoice*>(apvts.getParameter(pid::arp));
        REQUIRE(a != nullptr);
        CHECK(a->choices == juce::StringArray{"off", "up", "down", "updown", "random"});
    }
}

TEST_CASE("Default program — fresh insert plays motion on first boundary", "[plugin][defaults]")
{
    // A fresh device must produce audible chord motion under playback. With
    // default cells = all Hold, the walker emits no notes (Walker.cpp: Hold
    // sets played=false). Default cells therefore start as the canonical
    // "Mixed" preset (P, L, R, Hold) — same shape kFactoryPresets[3] uses.
    OedipaProcessor p;

    CHECK(p.getCell(0).op == Op::P);
    CHECK(p.getCell(1).op == Op::L);
    CHECK(p.getCell(2).op == Op::R);
    // Trailing cells stay Hold (length defaults to 4; cells[3..7] are
    // dormant under default length, kept Hold for the round-trip default).
    for (int i = 3; i < OedipaProcessor::kCellCount; ++i) {
        CHECK(p.getCell(i).op == Op::Hold);
    }

    // Slot 0 (the active slot on a fresh insert) must mirror the default
    // cells so switching to slot 1 and back round-trips to the same state.
    const auto& s0 = p.getSlot(0);
    CHECK(s0.ops[0] == Op::P);
    CHECK(s0.ops[1] == Op::L);
    CHECK(s0.ops[2] == Op::R);
    for (std::size_t i = 3; i < s0.ops.size(); ++i) {
        CHECK(s0.ops[i] == Op::Hold);
    }
}

TEST_CASE("State round-trip — APVTS + non-APVTS via get/setStateInformation", "[plugin][state]")
{

    OedipaProcessor source;
    auto& srcApvts = source.getApvts();

    // Mutate every APVTS param to a non-default value via the typed
    // parameter object's operator= (raw-pointer writes only update the
    // cached atomic, NOT the parameter — so they never reach the saved
    // ValueTree). Every assignment here is "what gets persisted."
    *paramAs<juce::AudioParameterInt>   (srcApvts, pid::stepsPerTransform) = 7;
    *paramAs<juce::AudioParameterChoice>(srcApvts, pid::voicing)           = 2;     // drop2
    *paramAs<juce::AudioParameterChoice>(srcApvts, pid::chordQuality)      = 1;     // 7th
    *paramAs<juce::AudioParameterFloat> (srcApvts, pid::jitter)            = 0.42f;
    *paramAs<juce::AudioParameterInt>   (srcApvts, pid::seed)              = 12345;
    *paramAs<juce::AudioParameterInt>   (srcApvts, pid::channel)           = 9;
    *paramAs<juce::AudioParameterChoice>(srcApvts, pid::triggerMode)       = 1;     // hold
    *paramAs<juce::AudioParameterInt>   (srcApvts, pid::inputChannel)      = 3;
    *paramAs<juce::AudioParameterChoice>(srcApvts, pid::stepDirection)     = 2;     // pingpong
    *paramAs<juce::AudioParameterFloat> (srcApvts, pid::outputLevel)       = 0.5f;
    *paramAs<juce::AudioParameterChoice>(srcApvts, pid::rhythm)            = 4;     // syncopated
    *paramAs<juce::AudioParameterChoice>(srcApvts, pid::arp)               = 3;     // updown
    *paramAs<juce::AudioParameterInt>   (srcApvts, pid::length)            = 6;
    *paramAs<juce::AudioParameterInt>   (srcApvts, pid::turingLength)      = 13;
    *paramAs<juce::AudioParameterFloat> (srcApvts, pid::turingLock)        = 0.33f;
    *paramAs<juce::AudioParameterInt>   (srcApvts, pid::turingSeed)        = 999;

    // Mutate non-APVTS state.
    source.setStartChord({62, 65, 69});  // D minor (D F A)

    Cell c0;
    c0.op = Op::P;
    c0.velocity = 0.8f;
    c0.gate = 0.5f;
    c0.probability = 0.9f;
    c0.timing = -0.1f;
    source.setCell(0, c0);

    Cell c3;
    c3.op = Op::Rest;
    c3.velocity = 0.25f;
    c3.gate = 0.75f;
    c3.probability = 1.0f;
    c3.timing = 0.05f;
    source.setCell(3, c3);

    Slot s1;
    s1.ops = {Op::L, Op::R, Op::P, Op::Hold, Op::Rest, Op::Hold, Op::Hold, Op::Hold};
    s1.startRootPc = 7;       // G
    s1.startQuality = Quality::Minor;
    s1.jitter = 0.15f;
    s1.seed = 0xCAFEBABEu;
    source.setSlot(1, s1);

    source.setAnchors({{0, 0, Quality::Major}, {16, 7, Quality::Minor}});

    // Round-trip.
    juce::MemoryBlock block;
    source.getStateInformation(block);
    REQUIRE(block.getSize() > 0);

    OedipaProcessor sink;
    sink.setStateInformation(block.getData(), (int) block.getSize());
    auto& dstApvts = sink.getApvts();

    SECTION("APVTS values restored") {
        CHECK((int) *dstApvts.getRawParameterValue(pid::stepsPerTransform) == 7);
        CHECK((int) *dstApvts.getRawParameterValue(pid::voicing) == 2);
        CHECK((int) *dstApvts.getRawParameterValue(pid::chordQuality) == 1);
        CHECK_THAT(*dstApvts.getRawParameterValue(pid::jitter),
                   Catch::Matchers::WithinAbs(0.42f, 1e-6f));
        CHECK((int) *dstApvts.getRawParameterValue(pid::seed) == 12345);
        CHECK((int) *dstApvts.getRawParameterValue(pid::channel) == 9);
        CHECK((int) *dstApvts.getRawParameterValue(pid::triggerMode) == 1);
        CHECK((int) *dstApvts.getRawParameterValue(pid::inputChannel) == 3);
        CHECK((int) *dstApvts.getRawParameterValue(pid::stepDirection) == 2);
        CHECK_THAT(*dstApvts.getRawParameterValue(pid::outputLevel),
                   Catch::Matchers::WithinAbs(0.5f, 1e-6f));
        CHECK((int) *dstApvts.getRawParameterValue(pid::rhythm) == 4);
        CHECK((int) *dstApvts.getRawParameterValue(pid::arp) == 3);
        CHECK((int) *dstApvts.getRawParameterValue(pid::length) == 6);
        CHECK((int) *dstApvts.getRawParameterValue(pid::turingLength) == 13);
        CHECK_THAT(*dstApvts.getRawParameterValue(pid::turingLock),
                   Catch::Matchers::WithinAbs(0.33f, 1e-6f));
        CHECK((int) *dstApvts.getRawParameterValue(pid::turingSeed) == 999);
    }

    SECTION("startChord restored") {
        const auto sc = sink.getStartChord();
        CHECK(sc[0] == 62);
        CHECK(sc[1] == 65);
        CHECK(sc[2] == 69);
    }

    SECTION("cells restored (mutated + untouched defaults)") {
        const auto& d0 = sink.getCell(0);
        CHECK(d0.op == Op::P);
        CHECK_THAT(d0.velocity,    Catch::Matchers::WithinAbs(0.8f, 1e-6f));
        CHECK_THAT(d0.gate,        Catch::Matchers::WithinAbs(0.5f, 1e-6f));
        CHECK_THAT(d0.probability, Catch::Matchers::WithinAbs(0.9f, 1e-6f));
        CHECK_THAT(d0.timing,      Catch::Matchers::WithinAbs(-0.1f, 1e-6f));

        const auto& d3 = sink.getCell(3);
        CHECK(d3.op == Op::Rest);
        CHECK_THAT(d3.velocity, Catch::Matchers::WithinAbs(0.25f, 1e-6f));

        // Untouched cells round-trip at the default Cell{} values.
        const auto& d7 = sink.getCell(7);
        CHECK(d7.op == Op::Hold);
        CHECK_THAT(d7.velocity, Catch::Matchers::WithinAbs(1.0f, 1e-6f));
    }

    SECTION("slots restored") {
        const auto& d1 = sink.getSlot(1);
        CHECK(d1.ops[0] == Op::L);
        CHECK(d1.ops[1] == Op::R);
        CHECK(d1.ops[2] == Op::P);
        CHECK(d1.ops[3] == Op::Hold);
        CHECK(d1.ops[4] == Op::Rest);
        CHECK(d1.startRootPc == 7);
        CHECK(d1.startQuality == Quality::Minor);
        CHECK_THAT(d1.jitter, Catch::Matchers::WithinAbs(0.15f, 1e-6f));
        CHECK(d1.seed == 0xCAFEBABEu);

        // Slot 0 is the active slot during all the mutations above —
        // auto-save (ADR 008 Phase 5) mirrors each user edit into the
        // active slot, so after round-trip slot 0 reflects the final
        // live state, not Slot{} defaults.
        const auto& d0 = sink.getSlot(0);
        CHECK(d0.ops[0] == Op::P);              // setCell(0, P)
        CHECK(d0.ops[3] == Op::Rest);           // setCell(3, Rest)
        CHECK(d0.startRootPc == 2);             // D from setStartChord({62,..})
        CHECK(d0.startQuality == Quality::Minor);
        CHECK_THAT(d0.jitter, Catch::Matchers::WithinAbs(0.42f, 1e-6f));
        CHECK(d0.seed == 12345u);

        // Active slot index round-trips.
        CHECK(sink.activeSlotIndex() == 0);
    }

    SECTION("anchors restored") {
        const auto& as = sink.getAnchors();
        REQUIRE(as.size() == 2);
        CHECK(as[0].step == 0);
        CHECK(as[0].rootPc == 0);
        CHECK(as[0].quality == Quality::Major);
        CHECK(as[1].step == 16);
        CHECK(as[1].rootPc == 7);
        CHECK(as[1].quality == Quality::Minor);
    }

    SECTION("OedipaState child carries version=1") {
        // Inspect the destination's saved state directly to assert the
        // schema-version stamp is present after round-trip.
        const auto state = dstApvts.copyState();
        const auto child = state.getChildWithName("OedipaState");
        REQUIRE(child.isValid());
        CHECK((int) child.getProperty("version") == OedipaProcessor::kStateVersion);
    }
}

TEST_CASE("State round-trip — empty anchors round-trip cleanly", "[plugin][state]")
{
    OedipaProcessor source;
    REQUIRE(source.getAnchors().empty());

    juce::MemoryBlock block;
    source.getStateInformation(block);

    OedipaProcessor sink;
    sink.setStateInformation(block.getData(), (int) block.getSize());

    CHECK(sink.getAnchors().empty());
}

// Audio-thread anchor snapshot sync. addAnchorAtNextStep / setAnchors /
// setStateInformation all run on the message thread; the audio thread
// consumes anchors via an atomically-published shared_ptr snapshot
// (lock-free read in handleWalkerMidi, no realloc race against editor
// push_back). Each writer must publish the snapshot or the audio thread
// reads stale data. This test pins all three publish paths.
TEST_CASE("Anchors — audio-thread snapshot syncs with editor mutations",
          "[plugin][anchors][threading]")
{
    using oedipa::engine::Quality;

    SECTION("addAnchorAtNextStep publishes to audio snapshot") {
        OedipaProcessor p;
        REQUIRE(p.getAnchors().empty());
        REQUIRE(p.getAudioAnchorsForTest().empty());

        p.addAnchorAtNextStep(7, Quality::Minor);  // G minor

        REQUIRE(p.getAnchors().size() == 1);
        REQUIRE(p.getAudioAnchorsForTest().size() == 1);
        const auto& snap = p.getAudioAnchorsForTest();
        CHECK(snap[0].rootPc == 7);
        CHECK(snap[0].quality == Quality::Minor);
        CHECK(snap[0].step == p.getAnchors()[0].step);
    }

    SECTION("setAnchors publishes to audio snapshot") {
        OedipaProcessor p;
        p.setAnchors({{0, 0, Quality::Major}, {16, 7, Quality::Minor}});
        REQUIRE(p.getAudioAnchorsForTest().size() == 2);
        CHECK(p.getAudioAnchorsForTest()[0].rootPc == 0);
        CHECK(p.getAudioAnchorsForTest()[1].rootPc == 7);

        p.setAnchors({});
        CHECK(p.getAudioAnchorsForTest().empty());
    }

    SECTION("setStateInformation publishes restored anchors") {
        OedipaProcessor source;
        source.setAnchors({{8, 4, Quality::Major}});
        juce::MemoryBlock data;
        source.getStateInformation(data);

        OedipaProcessor sink;
        REQUIRE(sink.getAudioAnchorsForTest().empty());
        sink.setStateInformation(data.getData(), (int) data.getSize());

        REQUIRE(sink.getAudioAnchorsForTest().size() == 1);
        CHECK(sink.getAudioAnchorsForTest()[0].step == 8);
        CHECK(sink.getAudioAnchorsForTest()[0].rootPc == 4);
    }
}

TEST_CASE("Phase 3 input contract — notes & sysex dropped, CC pass through", "[plugin][midi]")
{
    // Phase 3 owns note emission via the walker; ADR 004 (keyboard-driven
    // startChord) is a later phase. Until then, INPUT NOTES are dropped
    // so they don't double the walker. SYSEX is also dropped — Logic Pro
    // injects sysex (6 + 406 bytes) at transport-start that we have no
    // contract to relay. CC / pitch-bend / sustain / channel-pressure
    // continue to pass through to the downstream synth.
    OedipaProcessor p;
    p.prepareToPlay(44100.0, 512);

    const juce::uint8 sysexBytes[] = {0xF0, 0x7E, 0x7F, 0x06, 0x01, 0xF7};
    juce::MidiBuffer midi;
    midi.addEvent(juce::MidiMessage::noteOn(1, 60, (juce::uint8) 100), 0);
    midi.addEvent(juce::MidiMessage::controllerEvent(2, 11, 64), 32);
    midi.addEvent(juce::MidiMessage::createSysExMessage(sysexBytes, sizeof(sysexBytes)), 64);
    midi.addEvent(juce::MidiMessage::noteOff(1, 60), 256);

    juce::AudioBuffer<float> audio(0, 512);
    p.processBlock(audio, midi);

    int notes = 0;
    int ccs   = 0;
    int sysex = 0;
    for (const auto meta : midi) {
        const auto m = meta.getMessage();
        if (m.isNoteOn() || m.isNoteOff()) ++notes;
        else if (m.isController())         ++ccs;
        else if (m.isSysEx())              ++sysex;
    }
    CHECK(notes == 0);
    CHECK(sysex == 0);
    CHECK(ccs   == 1);

    p.releaseResources();
}

namespace {

// Minimal AudioPlayHead fake. Drives processBlock with a controllable
// (isPlaying, ppqPosition) state. Constructed once per test; mutated
// between processBlock calls to simulate transport advance, stop, and
// backward scrub.
class FakePlayHead : public juce::AudioPlayHead
{
public:
    juce::Optional<PositionInfo> getPosition() const override
    {
        PositionInfo info;
        info.setIsPlaying(playing);
        info.setPpqPosition(ppq);
        info.setBpm(120.0);
        return juce::Optional<PositionInfo>{info};
    }

    bool playing = true;
    double ppq = 0.0;
};

// Iterate all MIDI note events in a buffer and return them as a flat
// list of (samplePos, isOn, channel, noteNumber, velocity) tuples in
// emission order. CC and other messages are ignored — Phase 3 only
// emits notes.
struct NoteEvt { int sample; bool on; int channel; int note; int velocity; };
std::vector<NoteEvt> collectNotes(const juce::MidiBuffer& midi)
{
    std::vector<NoteEvt> out;
    for (const auto meta : midi) {
        const auto m = meta.getMessage();
        if (m.isNoteOn())  out.push_back({meta.samplePosition, true,  m.getChannel(), m.getNoteNumber(), m.getVelocity()});
        if (m.isNoteOff()) out.push_back({meta.samplePosition, false, m.getChannel(), m.getNoteNumber(), 0});
    }
    return out;
}

std::set<int> noteSet(const std::vector<NoteEvt>& evts, bool wantOn)
{
    std::set<int> s;
    for (const auto& e : evts) if (e.on == wantOn) s.insert(e.note);
    return s;
}

std::set<int> pcSet(const std::set<int>& notes)
{
    std::set<int> s;
    for (int n : notes) s.insert(((n % 12) + 12) % 12);
    return s;
}

}  // namespace

TEST_CASE("Phase 3 walker — fires expected chord progression at transform boundaries", "[plugin][walker]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();

    // Sub-step grid = 16ths, 1 boundary per sub-step (spt=1). Cells [P, L, R].
    // Walk from C major (default startChord):
    //   sub-step 1: cells[0]=P → C minor   PCs {0,3,7}
    //   sub-step 2: cells[1]=L → Ab major  PCs {0,3,8}
    //   sub-step 3: cells[2]=R → F  minor  PCs {0,5,8}
    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 1;
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 3;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::voicing)        = 0;  // close
    *paramAs<juce::AudioParameterChoice>(apvts, pid::chordQuality)   = 0;  // triad

    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::P, 1, 1, 1, 0});
    p.setCell(1, oedipa::engine::Cell{oedipa::engine::Op::L, 1, 1, 1, 0});
    p.setCell(2, oedipa::engine::Cell{oedipa::engine::Op::R, 1, 1, 1, 0});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 512);

    // Block 1 — playhead at ppq=0 (sub-step 0). m4l host.ts:471-484 fires
    // startChord at the cell head (synthetic init event with cellIdx=-1
    // played=true). The walker emits the held chord here; subsequent
    // boundaries apply transforms.
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.ppq = 0.0;
        p.processBlock(audio, midi);
        const auto notes = collectNotes(midi);
        REQUIRE(! notes.empty());
        const auto ons  = noteSet(notes, true);
        const auto offs = noteSet(notes, false);
        CHECK(offs.empty());                          // first fire, nothing to release
        CHECK(pcSet(ons) == std::set<int>{0, 4, 7});  // C major (startChord)
    }

    // Block 2 — playhead jumps to ppq=0.25 (sub-step 1, P boundary).
    // Expect: note-off for C major (head fire) + note-on for C minor.
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.ppq = 0.25;
        p.processBlock(audio, midi);
        const auto notes = collectNotes(midi);
        REQUIRE(!notes.empty());
        const auto ons  = noteSet(notes, true);
        const auto offs = noteSet(notes, false);
        CHECK(pcSet(offs) == std::set<int>{0, 4, 7});  // released C major
        CHECK(pcSet(ons)  == std::set<int>{0, 3, 7});  // C minor
    }

    // Block 3 — ppq=0.5 (sub-step 2, L boundary).
    // Expect: note-off for C minor + note-on for Ab major.
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.ppq = 0.5;
        p.processBlock(audio, midi);
        const auto notes = collectNotes(midi);
        const auto ons  = noteSet(notes, true);
        const auto offs = noteSet(notes, false);
        CHECK(pcSet(offs) == std::set<int>{0, 3, 7});  // released C minor
        CHECK(pcSet(ons)  == std::set<int>{0, 3, 8});  // attacked Ab major
    }

    // Block 4 — playhead jumps forward by 2 sub-steps in one block (catch-up).
    // ppq=1.0 (sub-step 4) crosses sub-steps 3 and 4:
    //   sub-step 3: cells[2]=R on Ab major → F minor   PCs {0,5,8}
    //   sub-step 4: cells[0]=P on F minor  → F major   PCs {0,5,9}
    // Final held = F major. Intermediate F-minor must appear and then be
    // released within the same block so we can assert both the final
    // chord and that note-off events came through.
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.ppq = 1.0;
        p.processBlock(audio, midi);
        const auto notes = collectNotes(midi);
        // Two attacks (sub-steps 3 and 4) plus their note-offs were emitted.
        // Counting events is fragile (gate scheduling is Phase 5+), so just
        // assert: at least one note-off, and the final held set is F major.
        CHECK(! noteSet(notes, false).empty());
        std::set<int> finalHeldPcs;
        for (const auto& [ch, note] : p.getHeldForTest()) finalHeldPcs.insert(((note % 12) + 12) % 12);
        CHECK(finalHeldPcs == std::set<int>{0, 5, 9});
    }

    p.releaseResources();
    p.setPlayHead(nullptr);
}

TEST_CASE("Phase 3 walker — transport stop emits panic note-offs for held notes", "[plugin][walker]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();
    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 1;
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 1;
    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::P, 1, 1, 1, 0});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 512);

    // Fire one chord.
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.ppq = 0.25;
        p.processBlock(audio, midi);
        REQUIRE(! p.getHeldForTest().empty());
    }

    // Stop transport.
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.playing = false;
        p.processBlock(audio, midi);
        const auto notes = collectNotes(midi);
        const auto offs  = noteSet(notes, false);
        CHECK(! offs.empty());
        CHECK(p.getHeldForTest().empty());
        CHECK(p.getLastSubStepForTest() == -1);  // walker resynced for next start
    }

    p.releaseResources();
    p.setPlayHead(nullptr);
}

TEST_CASE("Phase 3 walker — backward scrub panics held + resyncs from new pos", "[plugin][walker]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();
    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 1;
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 3;
    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::P, 1, 1, 1, 0});
    p.setCell(1, oedipa::engine::Cell{oedipa::engine::Op::L, 1, 1, 1, 0});
    p.setCell(2, oedipa::engine::Cell{oedipa::engine::Op::R, 1, 1, 1, 0});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 512);

    // Advance to sub-step 3 (Ab major already released, F minor held).
    juce::AudioBuffer<float> audio(0, 512);
    juce::MidiBuffer midi;
    playHead.ppq = 0.75;  // sub-step 3
    p.processBlock(audio, midi);
    REQUIRE(! p.getHeldForTest().empty());

    // Scrub back to sub-step 1.
    midi.clear();
    playHead.ppq = 0.25;
    p.processBlock(audio, midi);
    const auto notes = collectNotes(midi);
    // Panic releases the held F-minor PC set; new attack at sub-step 1
    // recomputes from pos=0 (walker reseeds), giving C minor again.
    const auto ons  = noteSet(notes, true);
    const auto offs = noteSet(notes, false);
    CHECK(! offs.empty());
    CHECK(pcSet(ons) == std::set<int>{0, 3, 7});  // C minor again

    p.releaseResources();
    p.setPlayHead(nullptr);
}

TEST_CASE("Walker — transport resume from non-zero ppq does not replay history", "[plugin][walker][resume]")
{
    // Logic Pro resumes playback from the stopped position rather than
    // rewinding to bar 1. Before the resume-skip fix, lastSubStep=-1
    // (set by the transport-stop branch) combined with a non-zero
    // currentSubStep made the catch-up loop iterate steps [0..currentSubStep],
    // emitting every cell-boundary chord at sample offset 0 of the
    // first block — audible as a click + cascade of simultaneous noteOns,
    // visible as a flash of the pre-stop chord history.
    //
    // Threshold derivation:
    //   - resume at ppq=5.0 → currentSubStep = floor(5.0 * 4) = 20
    //   - spt=4, length=3 → boundaries cross at steps {0, 4, 8, 12, 16, 20}
    //     = 6 cell boundaries. Without the fix, all 6 chord transitions
    //     fire at offset 0 (≥18 noteOns: 6 chords × 3 notes/triad).
    //   - With the fix, only the resume position fires (1 chord = 3 notes
    //     for a triad, no arp), all at sample offset 0 of this single block.
    //   - Assert ≤ 6 noteOns to pin "no cascade" while leaving headroom
    //     for any single-chord arp or future single-fire variation.
    OedipaProcessor p;
    auto& apvts = p.getApvts();
    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 4;
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 3;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::voicing)        = 0;  // close
    *paramAs<juce::AudioParameterChoice>(apvts, pid::chordQuality)   = 0;  // triad

    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::P, 1, 1, 1, 0});
    p.setCell(1, oedipa::engine::Cell{oedipa::engine::Op::L, 1, 1, 1, 0});
    p.setCell(2, oedipa::engine::Cell{oedipa::engine::Op::R, 1, 1, 1, 0});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 512);

    // Cold start at ppq=5.0 (= sub-step 20). Walker has lastSubStep=-1
    // (no prior block emitted). This is the resume-after-stop scenario.
    juce::AudioBuffer<float> audio(0, 512);
    juce::MidiBuffer midi;
    playHead.ppq = 5.0;
    p.processBlock(audio, midi);

    int noteOns = 0;
    for (const auto meta : midi) {
        if (meta.getMessage().isNoteOn()) ++noteOns;
    }
    CHECK(noteOns <= 6);

    p.releaseResources();
    p.setPlayHead(nullptr);
}

TEST_CASE("Phase 3 walker — anchor-reset semantics flow through processBlock", "[plugin][walker][anchor]")
{
    // ADR 008 Phase 3 explicitly calls out "Conformance to ADR 001
    // anchor-reset semantics" as a deliverable. Mirror the engine-level
    // anchor test (cells [L,R,P], anchor at step 2 = C major) and
    // verify the chord sequence reaches the host buffer correctly.
    OedipaProcessor p;
    auto& apvts = p.getApvts();
    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 1;
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 3;
    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::L, 1, 1, 1, 0});
    p.setCell(1, oedipa::engine::Cell{oedipa::engine::Op::R, 1, 1, 1, 0});
    p.setCell(2, oedipa::engine::Cell{oedipa::engine::Op::P, 1, 1, 1, 0});
    p.setAnchors({oedipa::engine::Anchor{2, 0, oedipa::engine::Quality::Major}});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 512);

    // Run blocks one sub-step at a time to capture per-step output.
    auto firePcsAt = [&](double targetPpq) {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.ppq = targetPpq;
        p.processBlock(audio, midi);
        std::set<int> finalHeldPcs;
        for (const auto& [ch, note] : p.getHeldForTest()) finalHeldPcs.insert(((note % 12) + 12) % 12);
        return finalHeldPcs;
    };

    CHECK(firePcsAt(0.25) == std::set<int>{4, 7, 11});  // sub-step 1: L on C maj → E minor
    CHECK(firePcsAt(0.50) == std::set<int>{0, 4, 7});   // sub-step 2: anchor → C major
    CHECK(firePcsAt(0.75) == std::set<int>{4, 7, 11});  // sub-step 3: counter reset → cells[0]=L again → E minor

    p.releaseResources();
    p.setPlayHead(nullptr);
}

// ──────────────────────────────────────────────────────────────────────────
// Integration tests: each APVTS parameter that the editor exposes must
// have an audible effect at processBlock. These cases cover the wiring
// gaps surfaced during the Phase-5 audit: rhythm, arp, per-cell velocity.
// They are deliberately end-to-end (param → processBlock → MIDI bytes)
// so the next port that forgets to wire a parameter fails here, not in
// manual host-smoke months later.
// ──────────────────────────────────────────────────────────────────────────

namespace {
// Drive the plugin one sub-step at a time and collect attack note-ons in
// the produced MIDI for that block. Returns sorted note numbers (0..127).
std::vector<int> attackNotesAt(OedipaProcessor& p,
                               FakePlayHead& playHead,
                               double targetPpq)
{
    juce::AudioBuffer<float> audio(0, 512);
    juce::MidiBuffer midi;
    playHead.ppq = targetPpq;
    p.processBlock(audio, midi);
    std::vector<int> out;
    for (const auto meta : midi) {
        const auto m = meta.getMessage();
        if (m.isNoteOn()) out.push_back(m.getNoteNumber());
    }
    std::sort(out.begin(), out.end());
    return out;
}

int firstAttackVelocityAt(OedipaProcessor& p,
                          FakePlayHead& playHead,
                          double targetPpq)
{
    juce::AudioBuffer<float> audio(0, 512);
    juce::MidiBuffer midi;
    playHead.ppq = targetPpq;
    p.processBlock(audio, midi);
    for (const auto meta : midi) {
        const auto m = meta.getMessage();
        if (m.isNoteOn()) return m.getVelocity();
    }
    return -1;
}
}  // namespace

TEST_CASE("APVTS rhythm — Onbeat fires only on quarter-note grid", "[plugin][rhythm][integration]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();

    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 16;  // long cell so all sub-steps stay inside cell 0
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 1;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::voicing)        = 0;   // close
    *paramAs<juce::AudioParameterChoice>(apvts, pid::chordQuality)   = 0;   // triad
    *paramAs<juce::AudioParameterChoice>(apvts, pid::rhythm)         = 2;   // onbeat (idx % 4 == 0)
    *paramAs<juce::AudioParameterChoice>(apvts, pid::arp)            = 0;   // off

    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::Hold, 1, 1, 1, 0});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 512);

    // sub-steps 0..7 within the cell. Onbeat fires at idx 0 + 4 only.
    CHECK(attackNotesAt(p, playHead, 0.0  ).size() > 0);  // idx 0 — head fire
    CHECK(attackNotesAt(p, playHead, 0.25 ).empty());      // idx 1
    CHECK(attackNotesAt(p, playHead, 0.5  ).empty());      // idx 2
    CHECK(attackNotesAt(p, playHead, 0.75 ).empty());      // idx 3
    CHECK(attackNotesAt(p, playHead, 1.0  ).size() > 0);  // idx 4
    CHECK(attackNotesAt(p, playHead, 1.25 ).empty());      // idx 5
    CHECK(attackNotesAt(p, playHead, 1.75 ).empty());      // idx 7

    p.releaseResources();
    p.setPlayHead(nullptr);
}

TEST_CASE("APVTS rhythm — Legato fires only at the cell head", "[plugin][rhythm][integration]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();

    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 4;
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 1;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::rhythm)         = 1;   // legato
    *paramAs<juce::AudioParameterChoice>(apvts, pid::arp)            = 0;   // off

    // Op::P (not Hold) — Hold sets played=false in walkStepEvent so the
    // walker never fires at cell boundaries with Hold cells, regardless
    // of rhythm. Legato gating is layered ON TOP of `played`.
    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::P, 1, 1, 1, 0});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 512);

    CHECK(attackNotesAt(p, playHead, 0.0).size() > 0);   // head fire (init)
    CHECK(attackNotesAt(p, playHead, 0.25).empty());      // mid-cell silent under legato
    CHECK(attackNotesAt(p, playHead, 0.5).empty());
    CHECK(attackNotesAt(p, playHead, 0.75).empty());
    // ppq=1.0 = sub-step 4 = next cell boundary, op=P, played=true:
    // legato gating allows the head fire.
    CHECK(attackNotesAt(p, playHead, 1.0).size() > 0);

    p.releaseResources();
    p.setPlayHead(nullptr);
}

TEST_CASE("APVTS arp — Up fires a single note that walks the voiced chord", "[plugin][arp][integration]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();

    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 16;  // long cell
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 1;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::voicing)        = 0;   // close — 3-note voicing
    *paramAs<juce::AudioParameterChoice>(apvts, pid::chordQuality)   = 0;   // triad (3 notes)
    *paramAs<juce::AudioParameterChoice>(apvts, pid::rhythm)         = 0;   // all (every sub-step fires)
    *paramAs<juce::AudioParameterChoice>(apvts, pid::arp)            = 1;   // up

    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::Hold, 1, 1, 1, 0});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 512);

    // Each sub-step should emit exactly one note (the arp picks one voiced
    // index per fire). Walks 0,1,2,0,1,2 over a 3-note triad.
    const auto a0 = attackNotesAt(p, playHead, 0.0);
    const auto a1 = attackNotesAt(p, playHead, 0.25);
    const auto a2 = attackNotesAt(p, playHead, 0.5);
    const auto a3 = attackNotesAt(p, playHead, 0.75);
    REQUIRE(a0.size() == 1);
    REQUIRE(a1.size() == 1);
    REQUIRE(a2.size() == 1);
    REQUIRE(a3.size() == 1);
    // Up cycles 0,1,2,0 so index 0 and index 3 land on the same note.
    CHECK(a0[0] == a3[0]);
    CHECK(a0[0] != a1[0]);
    CHECK(a1[0] != a2[0]);

    p.releaseResources();
    p.setPlayHead(nullptr);
}

TEST_CASE("APVTS per-cell velocity — scales the output noteOn velocity", "[plugin][cells][integration]")
{
    // Set spt=1 so EVERY sub-step is a cell boundary — this ensures the
    // attack at sub-step 1 reflects cells[0]'s velocity (cellIdx=0), not
    // the synthetic init event (cellIdx=-1, which uses default velocity).
    auto velocityAt = [](float cellVel) {
        OedipaProcessor p;
        auto& apvts = p.getApvts();
        *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 1;
        *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 1;
        *paramAs<juce::AudioParameterFloat>(apvts, pid::outputLevel)     = 1.0f;
        p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::P, cellVel, 1.0f, 1.0f, 0.0f});

        FakePlayHead playHead;
        p.setPlayHead(&playHead);
        p.prepareToPlay(44100.0, 512);

        // Pump sub-step 0 (init fire) so we're past the synthetic init
        // event when we measure.
        attackNotesAt(p, playHead, 0.0);
        // sub-step 1 is the first walkStepEvent boundary (spt=1) → its
        // cellIdx is 0, so cells[0].velocity scales the noteOn.
        const int v = firstAttackVelocityAt(p, playHead, 0.25);

        p.releaseResources();
        p.setPlayHead(nullptr);
        return v;
    };

    const int v100 = velocityAt(1.0f);
    const int v050 = velocityAt(0.5f);
    const int v010 = velocityAt(0.1f);

    CHECK(v100 > v050);
    CHECK(v050 > v010);
    CHECK(v010 >= 1);  // 0.1 * 127 ≈ 13 → still audible.
}

TEST_CASE("Per-cell velocity — cellVel == 0 emits no note-on (silent expression cell)", "[plugin][cells][velocity-zero]")
{
    // Cell::velocity is documented as 0..1 with default 1.0; velocity=0 is
    // a soft-mute the user reaches for to silence one cell of a program
    // without breaking the rhythmic cycle. Previously cellVel=0 → vel=1
    // floor (the std::clamp in handleWalkerMidi rounded 0 → 0 → clamped
    // to 1), producing an audible pp note where the user expected
    // silence. The fix: short-circuit before the clamp so heldTarget
    // stays empty and no noteOn is emitted — but the legato handoff
    // noteOff for any prior chord still emits.
    OedipaProcessor p;
    auto& apvts = p.getApvts();
    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 1;
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 1;
    *paramAs<juce::AudioParameterFloat>(apvts, pid::outputLevel)     = 1.0f;
    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::P, 0.0f, 1.0f, 1.0f, 0.0f});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 512);

    // Pump init fire (synthetic init event with default vel=1.0).
    attackNotesAt(p, playHead, 0.0);
    // First cell-boundary fire — cells[0] applies, cellVel=0 → silent.
    const auto notes = attackNotesAt(p, playHead, 0.25);
    CHECK(notes.empty());

    // The held bookkeeping must reflect "nothing currently sounding"
    // (heldTarget left empty), so a subsequent transport stop's panic
    // doesn't emit note-offs for never-on'd notes.
    CHECK(p.getHeldForTest().empty());

    p.releaseResources();
    p.setPlayHead(nullptr);
}

TEST_CASE("Bus config — pure MIDI fx, no audio buses (ADR 009 2026-05-08)",
          "[plugin][bus]")
{
    // Regression guard against re-introducing the Cubase instrument-disguise
    // topology (stub stereo output bus + IS_SYNTH=TRUE) that ADR 008
    // §2026-05-07 added and ADR 009 §Revised 2026-05-08 rolled back. Pin
    // the clean MIDI fx shape:
    //
    //   1. No audio buses on input or output. JUCE's default-constructed
    //      AudioProcessor (no BusesProperties argument) has zero buses,
    //      which is the correct shape for a MIDI fx with NEEDS_MIDI_INPUT
    //      / NEEDS_MIDI_OUTPUT / IS_MIDI_EFFECT.
    //
    //   2. MIDI flags: isMidiEffect / acceptsMidi / producesMidi all true.
    //      The AU type (`aumi`) is driven by IS_MIDI_EFFECT; flipping it
    //      would silently break the Logic MIDI FX slot.
    OedipaProcessor p;

    CHECK(p.getBusCount(false) == 0);
    CHECK(p.getBusCount(true)  == 0);

    CHECK(p.isMidiEffect()  == true);
    CHECK(p.acceptsMidi()   == true);
    CHECK(p.producesMidi()  == true);
}

// ── Cell timing — forward sample offset (concept.md §Traversal) ──────────
//
// Spec: per-cell `timing` is a 0..+0.5 step-length-fraction offset that pushes
// the cell-head fire later. m4l implements this via `delayPos` → Max [pipe];
// vst implements it as a within-block `sampleOffset` on the MidiBuffer event,
// with a one-deep deferred queue for offsets that fall past the current block.
//
// Both the legato handoff offs (for the previously-held chord) and the new
// chord's note-ons share the same offset — they form a single "fire" event
// whose moment-in-time the user has displaced.
//
// Numeric setup (used in the cases below):
//   sampleRate = 44100, bpm = 120 → samples/quarter = 22050, samples/sub-step
//   = 5512.5. With stepsPerTransform=1 (cell = 1 sub-step), one cell duration
//   = 5512.5 samples. timing=0.25 → 1378 samples; timing=0.5 → 2756 samples.

TEST_CASE("Cell timing — within-block offset for small timing values",
          "[plugin][walker][timing]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();

    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 1;
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 1;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::voicing)        = 0;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::chordQuality)   = 0;

    // cells[0] = P with timing=0.25. Cell duration is 5512.5 samples
    // (spt=1 at 120bpm/44100Hz), so the fire is delayed by 1378 samples
    // — well within the 4096-sample test block.
    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::P, 1.0f, 1.0f, 1.0f, 0.25f});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 4096);

    // Block 1 — ppq=0 init head: startChord (C major) fires at offset 0.
    // The init synthetic event has cellIdx=-1 and no per-cell timing.
    {
        juce::AudioBuffer<float> audio(0, 4096);
        juce::MidiBuffer midi;
        playHead.ppq = 0.0;
        p.processBlock(audio, midi);
        const auto notes = collectNotes(midi);
        REQUIRE(! notes.empty());
        for (const auto& e : notes) CHECK(e.sample == 0);
        CHECK(pcSet(noteSet(notes, true)) == std::set<int>{0, 4, 7});
    }

    // Block 2 — ppq=0.25 (sub-step 1, cells[0]=P boundary). cells[0].timing
    // = 0.25 → expected sample offset = round(0.25 × 5512.5) = 1378.
    // Both the C-major handoff offs and the C-minor note-ons sit at that
    // offset (the legato handoff is part of the displaced fire).
    {
        juce::AudioBuffer<float> audio(0, 4096);
        juce::MidiBuffer midi;
        playHead.ppq = 0.25;
        p.processBlock(audio, midi);
        const auto notes = collectNotes(midi);
        REQUIRE(! notes.empty());

        // 0.25 × (44100 × 60 / 120 / 4) = 0.25 × 5512.5 = 1378.125 → 1378.
        const int expectedOffset = (int) std::round(0.25 * 44100.0 * 15.0 / 120.0);
        for (const auto& e : notes) CHECK(e.sample == expectedOffset);

        CHECK(pcSet(noteSet(notes, false)) == std::set<int>{0, 4, 7});  // C major off
        CHECK(pcSet(noteSet(notes, true))  == std::set<int>{0, 3, 7});  // C minor on
    }
}

TEST_CASE("Cell timing — large offset defers across blocks",
          "[plugin][walker][timing]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();

    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 1;
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 1;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::voicing)        = 0;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::chordQuality)   = 0;

    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::P, 1.0f, 1.0f, 1.0f, 0.5f});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);

    // Block size 512 with timing offset 2756 samples → spans ~5.4 blocks.
    p.prepareToPlay(44100.0, 512);

    // Block 1 (samples 0..512) — ppq=0 init head: startChord at offset 0.
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.ppq = 0.0;
        p.processBlock(audio, midi);
        REQUIRE(! collectNotes(midi).empty());
    }

    // Block 2 (samples 512..1024) — ppq=0.25 crosses cells[0]=P boundary.
    // Fire is queued for absolute sample 512+2756 = 3268 (block 7's range).
    // Nothing emits in this block.
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.ppq = 0.25;
        p.processBlock(audio, midi);
        CHECK(collectNotes(midi).empty());
    }

    // Blocks 3..N — keep ppq in [0.25, 0.5) so no new boundary is crossed
    // while we wait for the deferred queue to drain. One block at 120bpm/
    // 44100Hz = 512/22050 quarters ≈ 0.02321 ppq.
    int firedBlockIndex = -1;
    int fireOffset = -1;
    std::set<int> firedOns, firedOffs;
    for (int b = 3; b <= 10; ++b) {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        const double advance = (b - 2) * 512.0 / 22050.0;
        playHead.ppq = std::min(0.499, 0.25 + advance);
        p.processBlock(audio, midi);
        const auto notes = collectNotes(midi);
        if (! notes.empty()) {
            firedBlockIndex = b;
            fireOffset = notes.front().sample;
            for (const auto& e : notes) CHECK(e.sample == fireOffset);
            firedOns  = noteSet(notes, true);
            firedOffs = noteSet(notes, false);
            break;
        }
    }

    // Pending fireSampleAbs = 512 + 2756 = 3268. Block 7 starts at sample
    // 3072 (= 6 × 512), so offset within block 7 = 3268 - 3072 = 196.
    CHECK(firedBlockIndex == 7);
    CHECK(fireOffset == 196);
    CHECK(pcSet(firedOffs) == std::set<int>{0, 4, 7});  // C major handoff
    CHECK(pcSet(firedOns)  == std::set<int>{0, 3, 7});  // C minor
}

TEST_CASE("Cell timing — transport stop drops the pending fire",
          "[plugin][walker][timing]")
{
    OedipaProcessor p;
    auto& apvts = p.getApvts();

    *paramAs<juce::AudioParameterInt>(apvts, pid::stepsPerTransform) = 1;
    *paramAs<juce::AudioParameterInt>(apvts, pid::length)            = 1;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::voicing)        = 0;
    *paramAs<juce::AudioParameterChoice>(apvts, pid::chordQuality)   = 0;

    p.setCell(0, oedipa::engine::Cell{oedipa::engine::Op::P, 1.0f, 1.0f, 1.0f, 0.5f});

    FakePlayHead playHead;
    p.setPlayHead(&playHead);
    p.prepareToPlay(44100.0, 512);

    // Block 1: init fires C major.
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.ppq = 0.0;
        p.processBlock(audio, midi);
        REQUIRE(! collectNotes(midi).empty());
    }

    // Block 2: queue P fire (deferred, no emit).
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.ppq = 0.25;
        p.processBlock(audio, midi);
        REQUIRE(collectNotes(midi).empty());
    }

    // Block 3: transport stop. Held = C major (init); pending = C minor.
    // Expected: panic emits noteOff for C major (currently sounding); the
    // pending C minor noteOns are dropped (never sounded).
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        playHead.playing = false;
        p.processBlock(audio, midi);
        const auto notes = collectNotes(midi);
        const auto ons  = noteSet(notes, true);
        const auto offs = noteSet(notes, false);
        CHECK(ons.empty());
        CHECK(pcSet(offs) == std::set<int>{0, 4, 7});
    }

    // Block 4: still stopped, no orphan fire from the dropped queue.
    {
        juce::AudioBuffer<float> audio(0, 512);
        juce::MidiBuffer midi;
        p.processBlock(audio, midi);
        CHECK(collectNotes(midi).empty());
    }
}
