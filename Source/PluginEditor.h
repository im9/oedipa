#pragma once
#include <JuceHeader.h>
#include "PluginProcessor.h"

class OedipaEditor : public juce::AudioProcessorEditor
{
public:
    explicit OedipaEditor(OedipaProcessor&);
    ~OedipaEditor() override = default;

    void paint(juce::Graphics&) override;
    void resized() override;

private:
    OedipaProcessor& processor;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OedipaEditor)
};
