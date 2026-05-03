#include "Plugin/PluginProcessor.h"

#include "Editor/PluginEditor.h"
#include "Plugin/Parameters.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_core/juce_core.h>

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

void OedipaProcessor::prepareToPlay(double, int) {}
void OedipaProcessor::releaseResources() {}

void OedipaProcessor::processBlock(juce::AudioBuffer<float>& audio, juce::MidiBuffer& midi)
{
    juce::ScopedNoDenormals noDenormals;

    // MIDI effect: zero audio channels, but processBlock can still receive
    // a sized buffer in some hosts. Clear it defensively.
    for (int ch = 0; ch < audio.getNumChannels(); ++ch) {
        audio.clear(ch, 0, audio.getNumSamples());
    }

    // Phase 2: MIDI in → MIDI out unchanged. Phase 3 will replace this with
    // engine-driven output (the input MIDI will instead drive startChord
    // recompute per ADR 004, and output will come from the walker).
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
