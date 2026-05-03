#include "Editor/PluginEditor.h"

namespace oedipa {
namespace editor {

OedipaEditor::OedipaEditor(plugin::OedipaProcessor& p)
    : AudioProcessorEditor(&p), processor(p)
{
    setSize(600, 400);
}

void OedipaEditor::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colours::black);
    g.setColour(juce::Colours::white);
    g.setFont(16.0f);
    // ASCII only — JUCE 8.x default font on macOS is mis-interpreting
    // multi-byte UTF-8 (em-dash 0xE2 0x80 0x94 rendered as 3 Latin-1
    // glyphs). Worth a deeper look if Phase 4 needs non-ASCII labels;
    // placeholder is going away anyway when the lattice lands.
    g.drawText("Oedipa - Tonnetz MIDI Effect", getLocalBounds(), juce::Justification::centred);
}

void OedipaEditor::resized() {}

}  // namespace editor
}  // namespace oedipa
