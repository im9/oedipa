// SEQ pills + length +/− + RATE slider — group 2 of the right rail
// (ADR 008 §Phase 5).
//
// Pill click toggles the drawer onto that cell — does not change the op.
// Op editing happens inside SequenceDrawerView (the row of mini-buttons
// above the per-cell sliders), keeping the pill itself a stable focus
// affordance. This is a small departure from inboil, which uses a
// dropdown per pill — vst's drawer concept moves op selection inside
// the drawer so the pill stays "this is cell N" rather than mixing
// "this is cell N AND its op IS X" with click semantics.

#pragma once

#include "Engine/SequenceDrawer.h"
#include "Plugin/PluginProcessor.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

#include <array>
#include <functional>

namespace oedipa {
namespace editor {

class SequenceRowView : public juce::Component, private juce::Timer
{
public:
    SequenceRowView(plugin::OedipaProcessor&, engine::SequenceDrawer&);
    ~SequenceRowView() override;

    void paint(juce::Graphics&) override;
    void resized() override;

    int preferredHeight() const;

    // Hooked from the host editor so the drawer can be moved/resized
    // when length changes invalidate the selection.
    std::function<void()> onDrawerStateChanged;

private:
    void timerCallback() override;
    void onPillClicked(int cellIdx);
    void onLengthDelta(int delta);

    plugin::OedipaProcessor& processor_;
    engine::SequenceDrawer&  drawer_;

    std::array<juce::TextButton, plugin::OedipaProcessor::kCellCount> pills_{};
    juce::TextButton plusBtn_  { "+" };
    juce::TextButton minusBtn_ { juce::CharPointer_UTF8("\xE2\x88\x92") };  // U+2212 minus

    juce::Slider rateSlider_ { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::AudioProcessorValueTreeState::SliderAttachment rateAttachment_;

    int lastLength_ = -1;
    std::array<engine::Op, plugin::OedipaProcessor::kCellCount> lastOps_{};
    int lastDrawerSel_ = -1;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SequenceRowView)
};

}  // namespace editor
}  // namespace oedipa
