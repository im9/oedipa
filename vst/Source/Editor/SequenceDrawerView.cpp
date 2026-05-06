#include "Editor/SequenceDrawerView.h"

#include "Editor/Theme.h"

namespace oedipa {
namespace editor {

const std::array<engine::Op, 5> SequenceDrawerView::kOpOrder = {
    engine::Op::Hold, engine::Op::P, engine::Op::L, engine::Op::R, engine::Op::Rest
};

namespace {

const char* opShortLabel(engine::Op op)
{
    switch (op) {
        case engine::Op::P:    return "P";
        case engine::Op::L:    return "L";
        case engine::Op::R:    return "R";
        case engine::Op::Rest: return "Rest";
        case engine::Op::Hold: return "Hold";
    }
    return "Hold";
}

void styleSlider(juce::Slider& s)
{
    s.setRange(0.0, 1.0, 0.001);
    s.setColour(juce::Slider::trackColourId, theme::olive.withAlpha(0.6f));
    s.setColour(juce::Slider::backgroundColourId, theme::lzBorder);
    s.setColour(juce::Slider::thumbColourId, theme::olive);
    s.setColour(juce::Slider::textBoxTextColourId, theme::fg);
    s.setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    s.setColour(juce::Slider::textBoxBackgroundColourId, theme::bg);
    s.textFromValueFunction = [](double v) { return juce::String(v, 2); };
    s.setTextBoxStyle(juce::Slider::TextBoxRight, false, 48, theme::rowHeight);
    s.updateText();
}

}  // namespace

SequenceDrawerView::SequenceDrawerView(plugin::OedipaProcessor& p, engine::SequenceDrawer& d)
    : processor_(p), drawer_(d)
{
    for (int i = 0; i < (int) opButtons_.size(); ++i) {
        auto& b = opButtons_[(std::size_t) i];
        b.setButtonText(opShortLabel(kOpOrder[(std::size_t) i]));
        b.setColour(juce::TextButton::buttonColourId,    theme::bg);
        b.setColour(juce::TextButton::buttonOnColourId,  theme::olive);
        b.setColour(juce::TextButton::textColourOffId,   theme::fg.withAlpha(0.7f));
        b.setColour(juce::TextButton::textColourOnId,    theme::bg);
        b.setClickingTogglesState(false);
        const auto op = kOpOrder[(std::size_t) i];
        b.onClick = [this, op] { writeOp(op); };
        addAndMakeVisible(b);
    }

    styleSlider(velSlider_);
    styleSlider(gateSlider_);
    styleSlider(probSlider_);
    timingSlider_.setRange(-1.0, 1.0, 0.01);
    timingSlider_.setColour(juce::Slider::trackColourId, theme::olive.withAlpha(0.6f));
    timingSlider_.setColour(juce::Slider::backgroundColourId, theme::lzBorder);
    timingSlider_.setColour(juce::Slider::thumbColourId, theme::olive);
    timingSlider_.setColour(juce::Slider::textBoxTextColourId, theme::fg);
    timingSlider_.setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    timingSlider_.setColour(juce::Slider::textBoxBackgroundColourId, theme::bg);
    timingSlider_.textFromValueFunction = [](double v) { return juce::String(v, 2); };
    timingSlider_.setTextBoxStyle(juce::Slider::TextBoxRight, false, 48, theme::rowHeight);
    timingSlider_.updateText();

    velSlider_   .onValueChange = [this] { writeField(engine::CellField::Velocity,    (float) velSlider_   .getValue()); };
    gateSlider_  .onValueChange = [this] { writeField(engine::CellField::Gate,        (float) gateSlider_  .getValue()); };
    probSlider_  .onValueChange = [this] { writeField(engine::CellField::Probability, (float) probSlider_  .getValue()); };
    timingSlider_.onValueChange = [this] { writeField(engine::CellField::Timing,      (float) timingSlider_.getValue()); };

    addAndMakeVisible(velSlider_);
    addAndMakeVisible(gateSlider_);
    addAndMakeVisible(probSlider_);
    addAndMakeVisible(timingSlider_);

    startTimerHz(15);
}

SequenceDrawerView::~SequenceDrawerView() { stopTimer(); }

int SequenceDrawerView::preferredHeight() const
{
    if (! drawer_.isOpen()) return 0;
    // CELL N legend + op-button row + 4 slider rows + frame padding.
    // The legend row was missing from the original sum, which clipped the
    // bottom slider (TIME) by ~15 px in the right rail.
    return theme::groupPadY * 2
         + (int) theme::fsSm + theme::rowGap + 2
         + theme::rowHeight + theme::rowGap
         + (theme::rowHeight + theme::rowGap) * 3
         + theme::rowHeight;
}

void SequenceDrawerView::paint(juce::Graphics& g)
{
    g.fillAll(theme::bg);
    g.setColour(theme::lzBorder);
    g.drawRect(getLocalBounds(), 1);

    if (! drawer_.isOpen()) return;

    g.setFont(theme::dataFont(theme::fsSm, true));
    g.setColour(theme::fg.withAlpha(0.4f));
    const juce::String legend = juce::String("CELL ") + juce::String(drawer_.selectedCell() + 1);
    g.drawText(legend, theme::groupPadX + 4, theme::groupPadY,
               getWidth() - theme::groupPadX * 2,
               (int) theme::fsSm + 2, juce::Justification::topLeft);

    const int labelW = 36;
    const int rowY0 = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2 + theme::rowHeight + theme::rowGap;
    g.setFont(theme::dataFont(theme::fsMd, true));
    g.setColour(theme::fg.withAlpha(0.6f));
    const char* labels[] = { "VEL", "GATE", "PROB", "TIME" };
    for (int i = 0; i < 4; ++i) {
        g.drawText(labels[i],
                   theme::groupPadX,
                   rowY0 + i * (theme::rowHeight + theme::rowGap),
                   labelW, theme::rowHeight,
                   juce::Justification::centredLeft);
    }
}

void SequenceDrawerView::resized()
{
    if (! drawer_.isOpen()) return;

    const int btnRowY = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2;
    const int btnGap = 2;
    const int btnAreaW = getWidth() - theme::groupPadX * 2;
    const int btnW = (btnAreaW - btnGap * ((int) opButtons_.size() - 1)) / (int) opButtons_.size();
    int x = theme::groupPadX;
    for (auto& b : opButtons_) {
        b.setBounds(x, btnRowY, btnW, theme::rowHeight);
        x += btnW + btnGap;
    }

    const int labelW = 36;
    const int rowY0 = btnRowY + theme::rowHeight + theme::rowGap;
    auto place = [&](juce::Slider& s, int row) {
        s.setBounds(theme::groupPadX + labelW,
                    rowY0 + row * (theme::rowHeight + theme::rowGap),
                    getWidth() - theme::groupPadX * 2 - labelW,
                    theme::rowHeight);
    };
    place(velSlider_,   0);
    place(gateSlider_,  1);
    place(probSlider_,  2);
    place(timingSlider_,3);
}

void SequenceDrawerView::timerCallback()
{
    const int sel = drawer_.selectedCell();
    if (sel != lastSelected_) {
        lastSelected_ = sel;
        if (sel >= 0) {
            const auto& cell = processor_.getCell(sel);
            // dontSendNotification — these come from state, not user input,
            // so we don't want to ping writeField back.
            velSlider_   .setValue(cell.velocity,    juce::dontSendNotification);
            gateSlider_  .setValue(cell.gate,        juce::dontSendNotification);
            probSlider_  .setValue(cell.probability, juce::dontSendNotification);
            timingSlider_.setValue(cell.timing,      juce::dontSendNotification);
        }
        repaint();
        return;
    }
    if (sel < 0) return;

    // Highlight the active op among the 5 buttons.
    const auto curOp = processor_.getCell(sel).op;
    for (int i = 0; i < (int) opButtons_.size(); ++i) {
        opButtons_[(std::size_t) i].setToggleState(kOpOrder[(std::size_t) i] == curOp,
                                                    juce::dontSendNotification);
    }
}

void SequenceDrawerView::writeOp(engine::Op op)
{
    const int sel = drawer_.selectedCell();
    if (sel < 0) return;
    auto cell = processor_.getCell(sel);
    cell.op = op;
    processor_.setCell(sel, cell);
}

void SequenceDrawerView::writeField(engine::CellField field, float value)
{
    const int sel = drawer_.selectedCell();
    if (sel < 0) return;
    processor_.setCellField(sel, field, value);
}

}  // namespace editor
}  // namespace oedipa
