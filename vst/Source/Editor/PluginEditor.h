// Top-level plugin editor. Phase 4: hosts a single LatticeView that fills
// the window. Phase 5 will add the right rail (Slots / Sequence / Voicing /
// Anchors / MIDI in / Output / Preset+Seed) and re-layout this as a
// 2-column body.
//
// ADR 008 boundary: Editor/ is allowed to depend on JUCE and on
// Engine/ + Plugin/, but NOT vice versa.

#pragma once

#include "Editor/LatticeView.h"
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
    LatticeView lattice;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OedipaEditor)
};

}  // namespace editor
}  // namespace oedipa
