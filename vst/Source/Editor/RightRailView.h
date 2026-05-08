// 280px right rail (ADR 008 §Phase 5 layout). Stacks the 6 group views
// vertically, top-to-bottom in inboil's parent→child order:
//   Slots → Sequence (+ optional Drawer) → Voicing → Anchors (cond) →
//   Output → Preset.
//
// Layout is JUCE FlexBox in `relayout()` so each group can request its
// current preferred height (drawer open/closed, anchors empty/non-empty,
// turing rhythm visibility).

#pragma once

#include "Editor/AnchorsView.h"
#include "Editor/OutputView.h"
#include "Editor/PresetView.h"
#include "Editor/SequenceDrawerView.h"
#include "Editor/SequenceRowView.h"
#include "Editor/SlotBarView.h"
#include "Editor/VoicingView.h"
#include "Engine/SequenceDrawer.h"
#include "Plugin/PluginProcessor.h"

#include <juce_gui_basics/juce_gui_basics.h>

namespace oedipa {
namespace editor {

class RightRailView : public juce::Component
{
public:
    explicit RightRailView(plugin::OedipaProcessor&);

    void paint(juce::Graphics&) override;
    void resized() override;

private:
    void relayout();

    plugin::OedipaProcessor& processor_;
    engine::SequenceDrawer   drawer_{};

    juce::Viewport viewport_;
    juce::Component content_;

    SlotBarView         slots_;
    SequenceRowView     sequenceRow_;
    SequenceDrawerView  sequenceDrawer_;
    VoicingView         voicing_;
    AnchorsView         anchors_;
    OutputView          output_;
    PresetView          preset_;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(RightRailView)
};

}  // namespace editor
}  // namespace oedipa
