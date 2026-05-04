// Editor wiring tests for ADR 008 Phase 4b.
//
// Hit-test (test_Lattice) and the pointer state machine
// (test_PointerInteraction) are covered separately. This file owns the
// glue: PointerOutcome → processor mutation + preview queueing. Pointer
// outcomes are injected via LatticeView::handleOutcomeForTest so the
// tests don't need to synthesise full juce::MouseEvent objects.

#include <catch2/catch_test_macros.hpp>

#include "Editor/LatticeView.h"
#include "Editor/PluginEditor.h"
#include "Engine/Lattice.h"
#include "Engine/PointerInteraction.h"
#include "Engine/State.h"
#include "Engine/Tonnetz.h"
#include "Plugin/Parameters.h"
#include "Plugin/PluginProcessor.h"

#include <juce_audio_basics/juce_audio_basics.h>
#include <juce_audio_processors/juce_audio_processors.h>

#include <algorithm>
#include <array>
#include <set>
#include <vector>

using namespace oedipa;

namespace {

std::array<engine::PitchClass, 3> sortPcs(engine::Triad t)
{
    std::array<engine::PitchClass, 3> pcs{
        ((t[0] % 12) + 12) % 12,
        ((t[1] % 12) + 12) % 12,
        ((t[2] % 12) + 12) % 12,
    };
    std::sort(pcs.begin(), pcs.end());
    return pcs;
}

engine::PointerOutcome tapOn(int idx)
{
    return {engine::PointerOutcome::Kind::Tap, {idx}};
}

engine::PointerOutcome dragThrough(std::vector<int> path)
{
    return {engine::PointerOutcome::Kind::Drag, std::move(path)};
}

engine::PointerOutcome anchorOn(int idx)
{
    return {engine::PointerOutcome::Kind::Anchor, {idx}};
}

}  // namespace

TEST_CASE("Editor Tap — sets startChord to the tapped triangle's PCs", "[editor][tap]")
{
    plugin::OedipaProcessor p;
    p.prepareToPlay(44100.0, 512);
    editor::OedipaEditor ed(p);
    auto& lv = ed.latticeViewForTest();

    // Default startChord = C major (60, 64, 67). With centerPc=0, triangle 0
    // is G major (PCs 2, 7, 11) — verified in test_Lattice.
    REQUIRE(p.getStartChord() == engine::Triad{60, 64, 67});

    lv.handleOutcomeForTest(tapOn(0));

    const auto pcs = sortPcs(p.getStartChord());
    const std::set<int> got{pcs.begin(), pcs.end()};
    CHECK(got == std::set<int>{2, 7, 11});
}

TEST_CASE("Editor Tap — queues a preview that fires on next processBlock", "[editor][preview]")
{
    plugin::OedipaProcessor p;
    p.prepareToPlay(44100.0, 512);
    editor::OedipaEditor ed(p);
    auto& lv = ed.latticeViewForTest();

    lv.handleOutcomeForTest(tapOn(0));

    juce::AudioBuffer<float> audio(0, 512);
    juce::MidiBuffer midi;
    p.processBlock(audio, midi);

    int noteOnCount = 0;
    for (const auto m : midi) {
        if (m.getMessage().isNoteOn()) ++noteOnCount;
    }
    // 3 note-ons for the tapped triad. Voicing / 7th not applied to preview
    // (raw triad — see PluginProcessor.cpp handlePreviewMidi).
    CHECK(noteOnCount == 3);
    CHECK(p.getPreviewHeldForTest().size() == 3);
}

TEST_CASE("Editor Drag — adjacent (P/L/R) path overwrites cells + sets length", "[editor][drag]")
{
    plugin::OedipaProcessor p;
    p.prepareToPlay(44100.0, 512);
    editor::OedipaEditor ed(p);
    auto& lv = ed.latticeViewForTest();

    // Triangle 0 = G major (PCs 2,7,11), triangle 1 = B minor (PCs 2,6,11).
    // G major --L--> B minor (verified in test_Lattice "C major → E minor (L)"
    // pattern — major --L--> minor with root +4). So drag [0, 1] resolves to [L].
    lv.handleOutcomeForTest(dragThrough({0, 1}));

    // startChord rebuilt to G major in the original octave (C-major-based).
    const auto startPcs = sortPcs(p.getStartChord());
    const std::set<int> got{startPcs.begin(), startPcs.end()};
    CHECK(got == std::set<int>{2, 7, 11});

    CHECK(p.getCell(0).op == engine::Op::L);

    // length follows ops.size() = 1.
    auto& apvts = p.getApvts();
    CHECK((int) *apvts.getRawParameterValue(plugin::pid::length) == 1);
}

TEST_CASE("Editor Drag — non-resolvable path leaves state untouched", "[editor][drag]")
{
    // Driven through the plugin entry directly: empty ops → no writeback.
    // (Lattice-level "non-adjacent silently skipped" is covered in test_Lattice.)
    plugin::OedipaProcessor p;
    p.prepareToPlay(44100.0, 512);

    const auto initialChord = p.getStartChord();
    const auto initialOp0   = p.getCell(0).op;

    p.applyDragResolution({60, 64, 67}, {});

    CHECK(p.getStartChord() == initialChord);
    CHECK(p.getCell(0).op == initialOp0);
}

TEST_CASE("Editor Anchor — appends to anchors at lastStep + spt*4", "[editor][anchor]")
{
    plugin::OedipaProcessor p;
    p.prepareToPlay(44100.0, 512);
    editor::OedipaEditor ed(p);
    auto& lv = ed.latticeViewForTest();

    REQUIRE(p.getAnchors().empty());

    // Default stepsPerTransform = 4. First anchor: max(empty)=0 + 4*4 = 16.
    lv.handleOutcomeForTest(anchorOn(0));

    REQUIRE(p.getAnchors().size() == 1);
    const auto& a0 = p.getAnchors().front();
    CHECK(a0.step == 16);
    CHECK(a0.rootPc == 7);                      // G
    CHECK(a0.quality == engine::Quality::Major);

    // Second anchor: max(16) + 16 = 32. Triangle 1 = B minor.
    lv.handleOutcomeForTest(anchorOn(1));
    REQUIRE(p.getAnchors().size() == 2);
    CHECK(p.getAnchors()[1].step == 32);
    CHECK(p.getAnchors()[1].rootPc == 11);      // B
    CHECK(p.getAnchors()[1].quality == engine::Quality::Minor);
}

TEST_CASE("Editor Anchor — also queues a preview of the anchored chord", "[editor][anchor]")
{
    plugin::OedipaProcessor p;
    p.prepareToPlay(44100.0, 512);
    editor::OedipaEditor ed(p);
    auto& lv = ed.latticeViewForTest();

    lv.handleOutcomeForTest(anchorOn(0));

    juce::AudioBuffer<float> audio(0, 512);
    juce::MidiBuffer midi;
    p.processBlock(audio, midi);

    int noteOnCount = 0;
    for (const auto m : midi) {
        if (m.getMessage().isNoteOn()) ++noteOnCount;
    }
    CHECK(noteOnCount == 3);
}

TEST_CASE("Plugin preview — note-off fires within the 300ms window", "[plugin][preview]")
{
    plugin::OedipaProcessor p;
    p.prepareToPlay(44100.0, 512);

    p.requestPreview({60, 64, 67});  // C major

    juce::AudioBuffer<float> audio(0, 512);
    juce::MidiBuffer midi;
    p.processBlock(audio, midi);

    // First block: 3 note-ons, no offs yet. 512 samples ≈ 11.6 ms < 300 ms.
    int onCount = 0;
    int offCount = 0;
    for (const auto m : midi) {
        const auto& msg = m.getMessage();
        if (msg.isNoteOn())  ++onCount;
        if (msg.isNoteOff()) ++offCount;
    }
    CHECK(onCount == 3);
    CHECK(offCount == 0);
    CHECK(p.isPreviewActiveForTest());

    // Drain blocks until the preview releases. 300 ms @ 44.1 kHz = 13230 samples.
    // Cap at twice the expected duration to avoid spinning if release misfires.
    const int maxSamples = (int) std::round(44100.0 * 0.3) * 2;
    int drained = 512;
    while (drained < maxSamples && p.isPreviewActiveForTest()) {
        midi.clear();
        p.processBlock(audio, midi);
        drained += 512;
        for (const auto m : midi) {
            if (m.getMessage().isNoteOff()) ++offCount;
        }
    }
    CHECK(offCount == 3);
    CHECK_FALSE(p.isPreviewActiveForTest());
}

TEST_CASE("Plugin preview — back-to-back requests release the prior chord first", "[plugin][preview]")
{
    plugin::OedipaProcessor p;
    p.prepareToPlay(44100.0, 512);

    p.requestPreview({60, 64, 67});  // C major
    juce::AudioBuffer<float> audio(0, 512);
    juce::MidiBuffer midi;
    p.processBlock(audio, midi);
    REQUIRE(p.getPreviewHeldForTest().size() == 3);

    // Stomp on the in-flight preview with a new chord before it releases.
    p.requestPreview({62, 65, 69});  // D minor (D, F, A)
    midi.clear();
    p.processBlock(audio, midi);

    int onCount = 0;
    int offCount = 0;
    for (const auto m : midi) {
        const auto& msg = m.getMessage();
        if (msg.isNoteOn())  ++onCount;
        if (msg.isNoteOff()) ++offCount;
    }
    CHECK(onCount == 3);
    CHECK(offCount == 3);
    REQUIRE(p.getPreviewHeldForTest().size() == 3);
    // Held now reflects the new chord (D minor, root note 62).
    CHECK(p.getPreviewHeldForTest()[0].second == 62);
}
