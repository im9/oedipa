#include "Editor/PluginEditor.h"

namespace oedipa {
namespace editor {

OedipaEditor::OedipaEditor(plugin::OedipaProcessor& p)
    : AudioProcessorEditor(&p), processor(p), lattice(p)
{
    addAndMakeVisible(lattice);
    setResizable(true, true);
    setResizeLimits(480, 320, 1600, 1200);
    setSize(720, 480);
}

void OedipaEditor::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colours::black);
}

void OedipaEditor::resized()
{
    lattice.setBounds(getLocalBounds());
}

}  // namespace editor
}  // namespace oedipa
