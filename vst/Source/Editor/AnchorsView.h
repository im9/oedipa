// Anchors group — conditional list (ADR 008 §Phase 5 group 4).
//
// Hidden when no anchors exist. Each anchor row: editable step number,
// chord label (e.g. `C`, `Em`), and a remove (×) button. New anchors
// are added via long-press on the lattice (Phase 4).

#pragma once

#include "Plugin/PluginProcessor.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <functional>
#include <memory>
#include <vector>

namespace oedipa {
namespace editor {

class AnchorsView : public juce::Component, private juce::Timer
{
public:
    explicit AnchorsView(plugin::OedipaProcessor&);
    ~AnchorsView() override;

    void paint(juce::Graphics&) override;
    void resized() override;

    int preferredHeight() const;

    std::function<void()> onAnchorsChanged;

private:
    struct Row {
        std::unique_ptr<juce::TextEditor> stepEditor;
        std::unique_ptr<juce::Label>      chordLabel;
        std::unique_ptr<juce::TextButton> removeBtn;
    };

    void timerCallback() override;
    void rebuildRows();
    void writeStep(int idx, int value);
    void removeAnchor(int idx);

    plugin::OedipaProcessor& processor_;
    std::vector<Row> rows_;
    std::size_t lastAnchorCount_ = 0;
    int lastVersion_ = -1;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(AnchorsView)
};

}  // namespace editor
}  // namespace oedipa
