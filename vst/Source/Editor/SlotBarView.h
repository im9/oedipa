// 4-pill slot bar — top of the right rail (ADR 008 §Phase 5 group 1).
//
// Slots are auto-saved on edit (per ADR 006 §Phase 3b); there is no
// explicit save button. The pill highlights the active slot in olive;
// click switches.

#pragma once

#include "Plugin/PluginProcessor.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <array>

namespace oedipa {
namespace editor {

class SlotBarView : public juce::Component, private juce::Timer
{
public:
    explicit SlotBarView(plugin::OedipaProcessor&);
    ~SlotBarView() override;

    void paint(juce::Graphics&) override;
    void resized() override;

    int preferredHeight() const;

private:
    void timerCallback() override;
    void onPillClicked(int idx);

    plugin::OedipaProcessor& processor_;
    std::array<juce::TextButton, plugin::OedipaProcessor::kSlotCount> pills_{};
    int lastActive_ = -1;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(SlotBarView)
};

}  // namespace editor
}  // namespace oedipa
