// Preset group — PRESET dropdown + SEED row (ADR 008 §Phase 5 group 6).
//
// Presets are static `engine::FactoryPreset` entries (Engine/Presets.h).
// Selecting a preset applies it to the active slot via processor.applySlot.
// SEED follows inboil's row idiom: numeric value when set, "off" when 0,
// dice icon = randomize, × icon = clear.

#pragma once

#include "Plugin/PluginProcessor.h"

#include <juce_audio_processors/juce_audio_processors.h>
#include <juce_gui_basics/juce_gui_basics.h>

namespace oedipa {
namespace editor {

class PresetView : public juce::Component, private juce::Timer
{
public:
    explicit PresetView(plugin::OedipaProcessor&);
    ~PresetView() override;

    void paint(juce::Graphics&) override;
    void resized() override;

    int preferredHeight() const;

private:
    void timerCallback() override;
    void applyPreset(int factoryIndex);
    void writeSeed(int value);

    plugin::OedipaProcessor& processor_;

    juce::ComboBox  presetCombo_;
    juce::Label     seedValueLabel_;
    juce::TextButton diceBtn_;
    juce::TextButton clearBtn_;

    int lastSeed_ = -2;

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(PresetView)
};

}  // namespace editor
}  // namespace oedipa
