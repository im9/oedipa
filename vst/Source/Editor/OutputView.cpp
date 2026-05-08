#include "Editor/OutputView.h"

#include "Editor/Theme.h"
#include "Plugin/Parameters.h"

namespace oedipa {
namespace editor {

namespace {

void styleSlider(juce::Slider& s)
{
    s.setColour(juce::Slider::trackColourId,    theme::olive.withAlpha(0.6f));
    s.setColour(juce::Slider::backgroundColourId, theme::lzBorder);
    s.setColour(juce::Slider::thumbColourId,    theme::olive);
    s.setColour(juce::Slider::textBoxTextColourId, theme::fg);
    s.setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    s.setColour(juce::Slider::textBoxBackgroundColourId, theme::bg);
    // Override the SliderAttachment's textFromValueFunction. The attachment
    // installs a lambda that calls AudioParameterFloat::getText(), which
    // formats with the JUCE-default "shortest unambiguous" decimals — for
    // a 0..1 float that's up to 7 digits ("1.0000000"). setNumDecimalPlaces
    // alone has no effect once the attachment hooks textFromValueFunction.
    s.textFromValueFunction = [](double v) { return juce::String(v, 2); };
    s.setTextBoxStyle(juce::Slider::TextBoxRight, false, 48, theme::rowHeight);
    // The slider's value-box is a Label whose text was already populated by
    // the SliderAttachment's earlier textFromValueFunction (param.getText —
    // up to 7 decimals). Without updateText() the cached "1.0000000" stays
    // visible until the user nudges the slider; force a refresh now.
    s.updateText();
}

}  // namespace

OutputView::OutputView(plugin::OedipaProcessor& p)
    : outAtt_  (p.getApvts(), plugin::pid::outputLevel, outSlider_),
      humanAtt_(p.getApvts(), plugin::pid::jitter,      humanSlider_)
{
    styleSlider(outSlider_);
    styleSlider(humanSlider_);
    addAndMakeVisible(outSlider_);
    addAndMakeVisible(humanSlider_);
}

int OutputView::preferredHeight() const
{
    return theme::groupPadY * 2
         + (int) theme::fsSm + theme::rowGap
         + theme::rowHeight * 2 + theme::rowGap;
}

void OutputView::paint(juce::Graphics& g)
{
    g.fillAll(theme::bg);
    g.setColour(theme::lzBorder);
    g.drawRect(getLocalBounds(), 1);

    g.setFont(theme::dataFont(theme::fsSm, true));
    g.setColour(theme::fg.withAlpha(0.4f));
    g.drawText("OUTPUT", theme::groupPadX + 4, theme::groupPadY,
               getWidth() - theme::groupPadX * 2,
               (int) theme::fsSm + 2, juce::Justification::topLeft);

    const int labelW = 56;
    const int rowY0 = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2;
    g.setFont(theme::dataFont(theme::fsMd, true));
    g.setColour(theme::fg.withAlpha(0.6f));
    int row = 0;
    // LEVEL = output velocity multiplier (was "OUT" — ambiguous next to
    // HUMAN). JITTER mirrors the parameter id and the engine concept
    // (probabilistic cell-op substitution); "HUMAN" was inherited from
    // m4l's humanizeDrift label and reads as "humanized timing", which
    // is not what this slider does.
    for (const char* lbl : { "LEVEL", "JITTER" }) {
        g.drawText(lbl, theme::groupPadX,
                   rowY0 + row * (theme::rowHeight + theme::rowGap),
                   labelW, theme::rowHeight, juce::Justification::centredLeft);
        ++row;
    }
}

void OutputView::resized()
{
    const int labelW = 56;
    const int rowY0 = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2;
    const int ctlX = theme::groupPadX + labelW;
    const int ctlW = getWidth() - theme::groupPadX * 2 - labelW;
    outSlider_  .setBounds(ctlX, rowY0,                                              ctlW, theme::rowHeight);
    humanSlider_.setBounds(ctlX, rowY0 + theme::rowHeight + theme::rowGap,           ctlW, theme::rowHeight);
}

}  // namespace editor
}  // namespace oedipa
