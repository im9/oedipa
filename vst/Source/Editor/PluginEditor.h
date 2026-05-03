// Placeholder editor — Phase 4 replaces this with the lattice UI.
//
// ADR 008 boundary: Editor/ is allowed to depend on JUCE and on
// Engine/ + Plugin/, but NOT vice versa. Lattice rendering and pointer
// dispatch will land here in Phase 4-5.

#pragma once

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

private:
    plugin::OedipaProcessor& processor;
    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(OedipaEditor)
};

}  // namespace editor
}  // namespace oedipa
