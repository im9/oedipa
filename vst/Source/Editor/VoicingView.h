// Voicing group — VOICE / CHORD / RHYTHM / ARP + Turing LEN/LOCK
// (ADR 008 §Phase 5 group 3).
//
// Turing LEN/LOCK are conditionally visible when RHYTHM == "turing"
// (matches inboil 1:1).

#pragma once

#include "Plugin/PluginProcessor.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <functional>
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

    // Fired when the Turing LEN/LOCK rows show/hide because the user
    // changed the RHYTHM combo to/from "turing" — preferredHeight steps
    // by 2 row heights. The rail listens and re-stacks groups so the
    // collapse/expand is visually reflected.
    std::function<void()> onTuringVisibilityChanged;

private:
    void timerCallback() override;

    plugin::OedipaProcessor& processor_;

    juce::ComboBox voiceCombo_;
    juce::ComboBox chordCombo_;
    juce::ComboBox rhythmCombo_;
    juce::ComboBox arpCombo_;

    // Constructed in the body AFTER the combos have been populated. The
    // attachment's initial sync on construction reads APVTS and calls
    // setSelectedId / setSelectedItemIndex on the combo — if the combo
    // is empty at that moment, the sync fails to land on the right item
    // and any later automation race can leave the combo desynchronized.
    using ComboAtt = juce::AudioProcessorValueTreeState::ComboBoxAttachment;
    std::unique_ptr<ComboAtt> voiceAtt_;
    std::unique_ptr<ComboAtt> chordAtt_;
    std::unique_ptr<ComboAtt> rhythmAtt_;
    std::unique_ptr<ComboAtt> arpAtt_;

    juce::Slider lenSlider_  { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::Slider lockSlider_ { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::AudioProcessorValueTreeState::SliderAttachment lenAtt_;
    juce::AudioProcessorValueTreeState::SliderAttachment lockAtt_;

    bool lastTuringVisible_ = false;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(VoicingView)
};

}  // namespace editor
}  // namespace oedipa
