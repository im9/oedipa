// Inline per-cell drawer (ADR 008 §Phase 5 group 2 inner).
//
// Visible only when `drawer_.isOpen()`. Shows an op selector row
// (Hold / P / L / R / Rest) and four sliders (vel / gate / prob / timing)
// for the cell at `drawer_.selectedCell()`. All edits route through the
// processor — op via setCell, numeric fields via setCellField (which is
// device-shared, NOT auto-saved into the slot, per m4l ADR 006 §Axis 1).

#pragma once

#include "Engine/SequenceDrawer.h"
#include "Engine/State.h"
#include "Plugin/PluginProcessor.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <array>

namespace oedipa {
namespace editor {

class SequenceDrawerView : public juce::Component, private juce::Timer
{
public:
    SequenceDrawerView(plugin::OedipaProcessor&, engine::SequenceDrawer&);
    ~SequenceDrawerView() override;

    void paint(juce::Graphics&) override;
    void resized() override;

    int preferredHeight() const;

private:
    void timerCallback() override;
    void writeOp(engine::Op op);
    void writeField(engine::CellField field, float value);

    plugin::OedipaProcessor& processor_;
    engine::SequenceDrawer&  drawer_;

    std::array<juce::TextButton, 5> opButtons_{};
    static const std::array<engine::Op, 5> kOpOrder;

    juce::Slider velSlider_  { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::Slider gateSlider_ { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::Slider probSlider_ { juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };
    juce::Slider timingSlider_{ juce::Slider::LinearHorizontal, juce::Slider::TextBoxRight };

    int lastSelected_ = -1;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SequenceDrawerView)
};

}  // namespace editor
}  // namespace oedipa
