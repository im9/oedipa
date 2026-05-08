#include "Editor/SlotBarView.h"

#include "Editor/Theme.h"

namespace oedipa {
namespace editor {

SlotBarView::SlotBarView(plugin::OedipaProcessor& p)
    : processor_(p)
{
    for (int i = 0; i < (int) pills_.size(); ++i) {
        auto& b = pills_[(std::size_t) i];
        b.setButtonText(juce::String(i + 1));
        b.setClickingTogglesState(false);
        b.setColour(juce::TextButton::buttonColourId, theme::bg);
        b.setColour(juce::TextButton::buttonOnColourId, theme::olive);
        b.setColour(juce::TextButton::textColourOffId, theme::fg);
        b.setColour(juce::TextButton::textColourOnId, theme::bg);
        b.onClick = [this, i] { onPillClicked(i); };
        addAndMakeVisible(b);
    }
    startTimerHz(15);
}

SlotBarView::~SlotBarView() { stopTimer(); }

int SlotBarView::preferredHeight() const
{
    return theme::groupPadY * 2 + theme::fsSm + theme::rowGap + theme::rowHeight;
}

void SlotBarView::paint(juce::Graphics& g)
{
    g.fillAll(theme::bg);
    g.setColour(theme::lzBorder);
    g.drawRect(getLocalBounds(), 1);

    g.setFont(theme::dataFont(theme::fsSm, true));
    g.setColour(theme::fg.withAlpha(0.4f));
    g.drawText("SLOTS",
               theme::groupPadX + 4,
               theme::groupPadY,
               getWidth() - theme::groupPadX * 2,
               (int) theme::fsSm + 2,
               juce::Justification::topLeft);
}

void SlotBarView::resized()
{
    const int pillGap = 6;
    const int top = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2;
    const int totalW = getWidth() - theme::groupPadX * 2;
    const int pillW = (totalW - pillGap * ((int) pills_.size() - 1)) / (int) pills_.size();
    int x = theme::groupPadX;
    for (auto& b : pills_) {
        b.setBounds(x, top, pillW, theme::rowHeight);
        x += pillW + pillGap;
    }
}

void SlotBarView::timerCallback()
{
    const int active = processor_.activeSlotIndex();
    if (active != lastActive_) {
        for (int i = 0; i < (int) pills_.size(); ++i) {
            pills_[(std::size_t) i].setToggleState(i == active, juce::dontSendNotification);
        }
        lastActive_ = active;
        repaint();
    }
}

void SlotBarView::onPillClicked(int idx)
{
    if (idx == processor_.activeSlotIndex()) return;
    processor_.switchSlot(idx);
}

}  // namespace editor
}  // namespace oedipa
