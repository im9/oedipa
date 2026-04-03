#include "PluginEditor.h"

OedipaEditor::OedipaEditor(OedipaProcessor& p)
    : AudioProcessorEditor(&p), processor(p)
{
    setSize(600, 400);
}

void OedipaEditor::paint(juce::Graphics& g)
{
    g.fillAll(juce::Colours::black);
    g.setColour(juce::Colours::white);
    g.setFont(16.0f);
    g.drawText("Oedipa — Tonnetz MIDI Effect", getLocalBounds(), juce::Justification::centred);
}

void OedipaEditor::resized() {}
