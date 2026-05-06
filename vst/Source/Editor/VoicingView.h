// Voicing group — VOICE / CHORD / RHYTHM / ARP + Turing LEN/LOCK
// (ADR 008 §Phase 5 group 3).
//
// Turing LEN/LOCK are conditionally visible when RHYTHM == "turing"
// (matches inboil 1:1).

#pragma once

#include "Plugin/PluginProcessor.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <memory>

namespace oedipa {
namespace editor {

class VoicingView : public juce::Component, private juce::Timer
{
public:
    explicit VoicingView(plugin::OedipaProcessor&);
    ~VoicingView() override;

    void paint(juce::Graphics&) override;
    void resized() override;

    int preferredHeight() const;

private:
    void timerCallback() override;

    plugin::OedipaProcessor& processor_;

    juce::ComboBox voiceCombo_;
    juce::ComboBox chordCombo_;
    juce::ComboBox rhythmCombo_;
    juce::ComboBox arpCombo_;

    juce::AudioProcessorValueTreeState::ComboBoxAttachment voiceAtt_;
    juce::AudioProcessorValueTreeState::ComboBoxAttachment chordAtt_;
    juce::AudioProcessorValueTreeState::ComboBoxAttachment rhythmAtt_;
    juce::AudioProcessorValueTreeState::ComboBoxAttachment arpAtt_;

    juce::Slider lenSlider_  { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::Slider lockSlider_ { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::AudioProcessorValueTreeState::SliderAttachment lenAtt_;
    juce::AudioProcessorValueTreeState::SliderAttachment lockAtt_;

    bool lastTuringVisible_ = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(VoicingView)
};

}  // namespace editor
}  // namespace oedipa
