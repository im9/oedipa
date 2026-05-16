#include "Editor/SequenceRowView.h"

#include "Editor/Theme.h"
#include "Plugin/Parameters.h"

#include <algorithm>

namespace oedipa {
namespace editor {

namespace {

// Returns juce::String (not const char*): the implicit decay from a
// CharPointer_UTF8 to const char* drops the UTF-8 marker, which causes
// "·" (U+00B7, two UTF-8 bytes 0xC2 0xB7) to render as the Latin-1 pair
// "Â·" once juce::String reconstructs the bytes. fromUTF8 keeps the
// glyph intact.
juce::String opLabel(engine::Op op)
{
    switch (op) {
        case engine::Op::P:    return "P";
        case engine::Op::L:    return "L";
        case engine::Op::R:    return "R";
        case engine::Op::Rest: return "-";
        case engine::Op::Hold: return juce::String::fromUTF8("\xC2\xB7");
    }
    return juce::String::fromUTF8("\xC2\xB7");
}

// Compact pill LookAndFeel: forces fsMd (10pt) and skips the trailing-
// ellipsis path. JUCE's default `getTextButtonFont` returns
// `min(15, height * 0.6)` ≈ 13pt at our rowHeight=22, which combined
// with LAF text padding overflows pillW≈16 (the natural width when
// length=8 fills the rail) and renders every pill as "...". A 10pt
// label fits cleanly.
class PillLookAndFeel : public juce::LookAndFeel_V4
{
public:
    juce::Font getTextButtonFont(juce::TextButton&, int /*buttonHeight*/) override
    {
        return theme::dataFont(theme::fsMd, true);
    }

    void drawButtonText(juce::Graphics& g, juce::TextButton& button,
                        bool /*shouldDrawHighlighted*/, bool /*shouldDrawDown*/) override
    {
        g.setFont(theme::dataFont(theme::fsMd, true));
        g.setColour(button.findColour(button.getToggleState()
                                       ? juce::TextButton::textColourOnId
                                       : juce::TextButton::textColourOffId));
        // useEllipsesIfTooBig=false: clip silently rather than render
        // "..." — at this size the digit/letter is intentionally tight.
        g.drawText(button.getButtonText(), button.getLocalBounds(),
                   juce::Justification::centred, false);
    }
};

PillLookAndFeel& pillLAF()
{
    static PillLookAndFeel laf;
    return laf;
}

}  // namespace

SequenceRowView::SequenceRowView(plugin::OedipaProcessor& p, engine::SequenceDrawer& d)
    : processor_(p),
      drawer_(d),
      rateAttachment_(p.getApvts(), plugin::pid::stepsPerTransform, rateSlider_)
{
    for (int i = 0; i < (int) pills_.size(); ++i) {
        auto& b = pills_[(std::size_t) i];
        b.setLookAndFeel(&pillLAF());
        b.setColour(juce::TextButton::buttonColourId,    theme::bg);
        b.setColour(juce::TextButton::buttonOnColourId,  theme::olive);
        b.setColour(juce::TextButton::textColourOffId,   theme::olive);
        b.setColour(juce::TextButton::textColourOnId,    theme::bg);
        b.setClickingTogglesState(false);
        b.onClick = [this, i] { onPillClicked(i); };
        // Seed the label from current state. Without this, timerCallback's
        // diff-on-change skips the first paint when cells[i].op happens to
        // equal Op{} (= Op::P, the enum's first value), leaving the pill
        // blank. Mirroring lastOps_ keeps the diff invariant.
        const auto op0 = processor_.getCell(i).op;
        b.setButtonText(opLabel(op0));
        lastOps_[(std::size_t) i] = op0;
        addAndMakeVisible(b);
    }
    plusBtn_ .onClick = [this] { onLengthDelta(+1); };
    minusBtn_.onClick = [this] { onLengthDelta(-1); };
    for (auto* b : { &plusBtn_, &minusBtn_ }) {
        b->setColour(juce::TextButton::buttonColourId, theme::bg);
        b->setColour(juce::TextButton::textColourOffId, theme::fg.withAlpha(0.6f));
        addAndMakeVisible(*b);
    }
    rateSlider_.setColour(juce::Slider::trackColourId,    theme::olive.withAlpha(0.6f));
    rateSlider_.setColour(juce::Slider::backgroundColourId, theme::lzBorder);
    rateSlider_.setColour(juce::Slider::thumbColourId,    theme::olive);
    rateSlider_.setColour(juce::Slider::textBoxTextColourId, theme::fg);
    rateSlider_.setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    rateSlider_.setColour(juce::Slider::textBoxBackgroundColourId, theme::bg);
    rateSlider_.setTextBoxStyle(juce::Slider::TextBoxRight, false, 32, theme::rowHeight);
    addAndMakeVisible(rateSlider_);

    startTimerHz(15);
}

SequenceRowView::~SequenceRowView()
{
    stopTimer();
    for (auto& b : pills_) b.setLookAndFeel(nullptr);
}

int SequenceRowView::preferredHeight() const
{
    // Legend + pill row + RATE row + frame padding.
    return theme::groupPadY * 2
         + (int) theme::fsSm + theme::rowGap
         + theme::rowHeight + theme::rowGap
         + theme::rowHeight;
}

void SequenceRowView::paint(juce::Graphics& g)
{
    g.fillAll(theme::bg);
    g.setColour(theme::lzBorder);
    g.drawRect(getLocalBounds(), 1);

    g.setFont(theme::dataFont(theme::fsSm, true));
    g.setColour(theme::fg.withAlpha(0.4f));
    g.drawText("SEQUENCE",
               theme::groupPadX + 4,
               theme::groupPadY,
               getWidth() - theme::groupPadX * 2,
               (int) theme::fsSm + 2,
               juce::Justification::topLeft);

    // SEQ row label
    g.setFont(theme::dataFont(theme::fsMd, true));
    g.setColour(theme::fg.withAlpha(0.6f));
    g.drawText("SEQ",
               theme::groupPadX,
               theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2,
               36,
               theme::rowHeight,
               juce::Justification::centredLeft);

    // RATE row label
    g.drawText("RATE",
               theme::groupPadX,
               theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2 + theme::rowHeight + theme::rowGap,
               36,
               theme::rowHeight,
               juce::Justification::centredLeft);

    // Drawer-focused pill: the active state (solid olive fill + light
    // text) is set via the button's toggle / onColour pair, matching the
    // SLOTS row. No extra paint() outline.
}

void SequenceRowView::resized()
{
    const int labelW = 36;
    const int seqRowY = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2;
    const int rateRowY = seqRowY + theme::rowHeight + theme::rowGap;

    // Visible pills follow `length` parameter.
    const int len = std::clamp((int) *processor_.getApvts().getRawParameterValue(plugin::pid::length),
                               1, plugin::OedipaProcessor::kCellCount);

    const int pillsAreaX = theme::groupPadX + labelW;
    const int controlsRightW = 24 + 24;  // +/- buttons
    const int controlsGap = 8;            // breathing room between pills and −
    const int pillsAreaW = getWidth() - pillsAreaX - controlsGap - controlsRightW - theme::groupPadX;

    const int pillGap = 2;
    // Cap pillW so short sequences (length=1..3) don't stretch a lone pill
    // across the full pills area. 32px keeps cells visually close to their
    // packed-tight width at length=8 (~16px) while staying readable.
    const int pillMaxW = 32;
    const int pillW = std::clamp((pillsAreaW - pillGap * (len - 1)) / std::max(1, len),
                                 16, pillMaxW);

    int x = pillsAreaX;
    for (int i = 0; i < (int) pills_.size(); ++i) {
        auto& b = pills_[(std::size_t) i];
        if (i < len) {
            b.setVisible(true);
            b.setBounds(x, seqRowY, pillW, theme::rowHeight);
            x += pillW + pillGap;
        } else {
            b.setVisible(false);
        }
    }

    minusBtn_.setBounds(getWidth() - theme::groupPadX - 24 - 24,
                        seqRowY, 22, theme::rowHeight);
    plusBtn_.setBounds(getWidth() - theme::groupPadX - 22,
                       seqRowY, 22, theme::rowHeight);

    rateSlider_.setBounds(theme::groupPadX + labelW,
                          rateRowY,
                          getWidth() - theme::groupPadX * 2 - labelW,
                          theme::rowHeight);
}

void SequenceRowView::timerCallback()
{
    bool dirty = false;
    const int len = std::clamp((int) *processor_.getApvts().getRawParameterValue(plugin::pid::length),
                               1, plugin::OedipaProcessor::kCellCount);
    if (len != lastLength_) {
        drawer_.onSequenceLengthChanged(len);
        lastLength_ = len;
        resized();
        dirty = true;
    }
    for (int i = 0; i < (int) pills_.size(); ++i) {
        const auto op = processor_.getCell(i).op;
        if (op != lastOps_[(std::size_t) i]) {
            pills_[(std::size_t) i].setButtonText(opLabel(op));
            lastOps_[(std::size_t) i] = op;
            dirty = true;
        }
    }
    const int sel = drawer_.selectedCell();
    if (sel != lastDrawerSel_) {
        for (int i = 0; i < (int) pills_.size(); ++i) {
            pills_[(std::size_t) i].setToggleState(i == sel, juce::dontSendNotification);
        }
        lastDrawerSel_ = sel;
        if (onDrawerStateChanged) onDrawerStateChanged();
        dirty = true;
    }
    if (dirty) repaint();
}

void SequenceRowView::onPillClicked(int cellIdx)
{
    drawer_.toggle(cellIdx);
    // Force an immediate refresh; the timer would catch it within 66 ms,
    // but the drawer should snap open on the same tick as the click.
    timerCallback();
}

void SequenceRowView::onLengthDelta(int delta)
{
    auto* lenParam = processor_.getApvts().getParameter(plugin::pid::length);
    if (lenParam == nullptr) return;
    const auto& range = lenParam->getNormalisableRange();
    const int cur = (int) *processor_.getApvts().getRawParameterValue(plugin::pid::length);
    const int next = std::clamp(cur + delta, 1, plugin::OedipaProcessor::kCellCount);
    if (next == cur) return;
    lenParam->setValueNotifyingHost(range.convertTo0to1((float) next));
}

}  // namespace editor
}  // namespace oedipa
