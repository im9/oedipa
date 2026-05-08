// Output group — OUT (level) + HUMAN (jitter) sliders.
// ADR 008 §Phase 5 group 5; carries forward m4l ADR 005 humanization.

#pragma once

#include "Plugin/PluginProcessor.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

namespace oedipa {
namespace editor {

class OutputView : public juce::Component
{
public:
    explicit OutputView(plugin::OedipaProcessor&);

    void paint(juce::Graphics&) override;
    void resized() override;

    int preferredHeight() const;

private:
    juce::Slider outSlider_   { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::Slider humanSlider_ { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::AudioProcessorValueTreeState::SliderAttachment outAtt_;
    juce::AudioProcessorValueTreeState::SliderAttachment humanAtt_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OutputView)
};

}  // namespace editor
}  // namespace oedipa
