// Top-level plugin editor (ADR 008 §Phase 5).
//
// Layout: header row (Oedipa title + 1px divider below) above a
// 2-column body — lattice on the left (flex), right rail (280px fixed)
// on the right.

#pragma once

#include "Editor/LatticeView.h"
#include "Editor/RightRailView.h"
#include "Plugin/PluginProcessor.h"

#include <juce_gui_basics/juce_gui_basics.h>

namespace oedipa {
namespace editor {

class OedipaEditor : public juce::AudioProcessorEditor
{
public:
    explicit OedipaEditor(plugin::OedipaProcessor&);
    ~OedipaEditor() override = default;

    void paint(juce::Graphics&) override;
    void resized() override;

    LatticeView& latticeViewForTest() { return lattice; }

private:
    plugin::OedipaProcessor& processor;
    LatticeView    lattice;
    RightRailView  rightRail;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OedipaEditor)
};

}  // namespace editor
}  // namespace oedipa
