// Plugin-level tests for ADR 008 Phase 2.
//
// Three concerns:
//   1. APVTS layout — every parameter from m4l HostParams is present with
//      the right type, range, default, and choice ordering. Choice ordering
//      is the wire format, so any reorder breaks saved presets.
//   2. State round-trip — getStateInformation → setStateInformation on a
//      fresh instance reproduces every APVTS param + every non-APVTS field
//      (cells, slots, anchors, startChord) and stamps version=1 on the
//      OedipaState child.
//   3. MIDI passthrough — processBlock copies the input MidiBuffer to the
//      output unchanged. Phase 3 will replace this with engine-driven
//      output, but Phase 2 ships passthrough so the device loads cleanly
//      in Live + Logic without producing silence on input.

#include <catch2/catch_test_macros.hpp>
#include <catch2/matchers/catch_matchers_floating_point.hpp>

#include "Engine/State.h"
#include "Plugin/Parameters.h"
#include "Plugin/PluginProcessor.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>

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
        // stepsPerTransform: int 1..32, default 4
        auto* spt = dynamic_cast<juce::AudioParameterInt*>(apvts.getParameter(pid::stepsPerTransform));
        REQUIRE(spt != nullptr);
        // m4l semantics: 1 sub-step = 1 fire; 4 = quarter note at 16th grid.
        // Range 1..32 covers single-16th up to 2-bar transforms.
        CHECK(spt->getRange().getStart() == 1);
        CHECK(spt->getRange().getEnd() == 32);
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

        // Untouched slot remains at default.
        const auto& d0 = sink.getSlot(0);
        CHECK(d0.ops[0] == Op::Hold);
        CHECK(d0.startRootPc == 0);
        CHECK(d0.startQuality == Quality::Major);
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

TEST_CASE("Bus layout — Live gets stub stereo output, every other host stays MIDI-only", "[plugin][buses]")
{
    // ADR 008 §"DAW integration": Live's VST3 host rejects zero-bus
    // plugins. We add a stub stereo OUTPUT bus only when the host is
    // Live (detected via PluginHostType().isAbletonLive() in production).
    // Every other host keeps zero buses so JUCE's IS_MIDI_EFFECT TRUE
    // path remains intact (notably AU's kAudioUnitType_MIDIProcessor
    // for Logic's MIDI FX slot).

    SECTION("non-Live host — zero buses, preserves MIDI-effect contract") {
        const auto buses = OedipaProcessor::makeBusesProperties(false);
        CHECK(buses.inputLayouts.size() == 0);
        CHECK(buses.outputLayouts.size() == 0);
    }

    SECTION("Live host — single stereo OUTPUT bus, no input bus") {
        const auto buses = OedipaProcessor::makeBusesProperties(true);
        // No input bus: Oedipa never reads audio. The Live host's
        // complaint was specifically "no audio input" but inspection of
        // the JUCE MidiLogger fix shows an OUTPUT bus is what Live
        // actually requires (it scans for SOME audio bus presence).
        CHECK(buses.inputLayouts.size() == 0);
        REQUIRE(buses.outputLayouts.size() == 1);
        CHECK(buses.outputLayouts[0].defaultLayout == juce::AudioChannelSet::stereo());
    }
}

TEST_CASE("MIDI passthrough — processBlock copies input MIDI to output unchanged", "[plugin][midi]")
{
    OedipaProcessor p;
    p.prepareToPlay(44100.0, 512);

    juce::MidiBuffer midi;
    // Mix of channels, message types, and timestamps so a partial
    // implementation (e.g. ch=1 only, or noteOn-only) is detectable.
    midi.addEvent(juce::MidiMessage::noteOn(1, 60, (juce::uint8) 100), 0);
    midi.addEvent(juce::MidiMessage::noteOn(7, 67, (juce::uint8) 80), 32);
    midi.addEvent(juce::MidiMessage::controllerEvent(2, 11, 64), 64);
    midi.addEvent(juce::MidiMessage::noteOff(1, 60), 256);

    juce::AudioBuffer<float> audio(0, 512);  // MIDI effect: zero audio channels
    p.processBlock(audio, midi);

    std::vector<std::tuple<int, int, int>> got;  // (sample, channel, noteNumberOrCC)
    for (const auto meta : midi) {
        const auto m = meta.getMessage();
        if (m.isNoteOn())              got.emplace_back(meta.samplePosition, m.getChannel(), m.getNoteNumber());
        else if (m.isNoteOff())        got.emplace_back(meta.samplePosition, m.getChannel(), -m.getNoteNumber());
        else if (m.isController())     got.emplace_back(meta.samplePosition, m.getChannel(), 1000 + m.getControllerNumber());
    }

    REQUIRE(got.size() == 4);
    CHECK(got[0] == std::make_tuple(0,   1,  60));
    CHECK(got[1] == std::make_tuple(32,  7,  67));
    CHECK(got[2] == std::make_tuple(64,  2,  1011));
    CHECK(got[3] == std::make_tuple(256, 1, -60));

    p.releaseResources();
}
