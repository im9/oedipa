#include "Editor/PresetView.h"

#include "Editor/Theme.h"
#include "Engine/Presets.h"
#include "Plugin/Parameters.h"

namespace oedipa {
namespace editor {

PresetView::PresetView(plugin::OedipaProcessor& p)
    : processor_(p)
{
    presetCombo_.addItem(juce::CharPointer_UTF8("\xE2\x80\x94"), 1);  // em dash = "no preset"
    for (int i = 0; i < engine::kFactoryPresetCount; ++i) {
        presetCombo_.addItem(juce::String(engine::kFactoryPresets[i].name.data(),
                                          engine::kFactoryPresets[i].name.size()),
                             i + 2);
    }
    presetCombo_.setSelectedId(1, juce::dontSendNotification);
    presetCombo_.setColour(juce::ComboBox::backgroundColourId, theme::bg);
    presetCombo_.setColour(juce::ComboBox::outlineColourId,    theme::lzBorderMid);
    presetCombo_.setColour(juce::ComboBox::textColourId,       theme::fg);
    presetCombo_.setColour(juce::ComboBox::arrowColourId,      theme::fg.withAlpha(0.5f));
    presetCombo_.onChange = [this] {
        const int sel = presetCombo_.getSelectedId();
        if (sel <= 1) return;  // em dash = no-op
        applyPreset(sel - 2);
        // Selection stays visible so the user can see which preset is
        // applied. To re-apply the same preset (e.g. after tweaking the
        // slot), select "—" first and then the preset again.
    };
    addAndMakeVisible(presetCombo_);

    seedValueLabel_.setColour(juce::Label::textColourId, theme::fg);
    seedValueLabel_.setFont(theme::dataFont(theme::fsLg, true));
    seedValueLabel_.setJustificationType(juce::Justification::centredLeft);
    addAndMakeVisible(seedValueLabel_);

    auto styleIcon = [](juce::TextButton& b) {
        b.setColour(juce::TextButton::buttonColourId, theme::bg);
        b.setColour(juce::TextButton::textColourOffId, theme::fg.withAlpha(0.6f));
    };
    diceBtn_.setButtonText(juce::CharPointer_UTF8("\xE2\x86\xBA"));   // ↺ randomize glyph
    clearBtn_.setButtonText(juce::CharPointer_UTF8("\xC3\x97"));        // ×
    styleIcon(diceBtn_);
    styleIcon(clearBtn_);
    diceBtn_.onClick  = [this] { writeSeed((int) (juce::Random::getSystemRandom().nextInt(99999) + 1)); };
    clearBtn_.onClick = [this] { writeSeed(0); };
    addAndMakeVisible(diceBtn_);
    addAndMakeVisible(clearBtn_);

    startTimerHz(15);
}

PresetView::~PresetView() { stopTimer(); }

int PresetView::preferredHeight() const
{
    return theme::groupPadY * 2
         + (int) theme::fsSm + theme::rowGap
         + theme::rowHeight * 2 + theme::rowGap;
}

void PresetView::paint(juce::Graphics& g)
{
    g.fillAll(theme::bg);
    g.setColour(theme::lzBorder);
    g.drawRect(getLocalBounds(), 1);

    g.setFont(theme::dataFont(theme::fsSm, true));
    g.setColour(theme::fg.withAlpha(0.4f));
    g.drawText("PRESET", theme::groupPadX + 4, theme::groupPadY,
               getWidth() - theme::groupPadX * 2,
               (int) theme::fsSm + 2, juce::Justification::topLeft);

    const int labelW = 56;
    const int rowY0 = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2;
    g.setFont(theme::dataFont(theme::fsMd, true));
    g.setColour(theme::fg.withAlpha(0.6f));
    g.drawText("PRESET", theme::groupPadX, rowY0, labelW, theme::rowHeight, juce::Justification::centredLeft);
    g.drawText("SEED",   theme::groupPadX, rowY0 + theme::rowHeight + theme::rowGap,
               labelW, theme::rowHeight, juce::Justification::centredLeft);
}

void PresetView::resized()
{
    const int labelW = 56;
    const int rowY0 = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2;
    const int ctlX = theme::groupPadX + labelW;
    const int rightW = 22 + 4 + 22;
    const int ctlW = getWidth() - theme::groupPadX * 2 - labelW;
    presetCombo_.setBounds(ctlX, rowY0, ctlW, theme::rowHeight);

    const int seedRowY = rowY0 + theme::rowHeight + theme::rowGap;
    seedValueLabel_.setBounds(ctlX, seedRowY, ctlW - rightW - 4, theme::rowHeight);
    diceBtn_ .setBounds(getWidth() - theme::groupPadX - 22 - 4 - 22, seedRowY, 22, theme::rowHeight);
    clearBtn_.setBounds(getWidth() - theme::groupPadX - 22,           seedRowY, 22, theme::rowHeight);
}

void PresetView::timerCallback()
{
    const int seed = (int) *processor_.getApvts().getRawParameterValue(plugin::pid::seed);
    if (seed != lastSeed_) {
        lastSeed_ = seed;
        seedValueLabel_.setText(seed > 0 ? juce::String(seed) : juce::String("off"),
                                juce::dontSendNotification);
        seedValueLabel_.setColour(juce::Label::textColourId,
                                  seed > 0 ? theme::fg : theme::fg.withAlpha(0.4f));
    }
}

void PresetView::applyPreset(int factoryIndex)
{
    if (factoryIndex < 0 || factoryIndex >= engine::kFactoryPresetCount) return;
    processor_.applySlot(engine::kFactoryPresets[factoryIndex].slot);
}

void PresetView::writeSeed(int value)
{
    auto* p = processor_.getApvts().getParameter(plugin::pid::seed);
    if (p == nullptr) return;
    const auto& range = p->getNormalisableRange();
    p->setValueNotifyingHost(range.convertTo0to1((float) value));
}

}  // namespace editor
}  // namespace oedipa
