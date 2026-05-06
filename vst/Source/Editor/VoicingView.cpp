#include "Editor/VoicingView.h"

#include "Editor/Theme.h"
#include "Plugin/Parameters.h"

namespace oedipa {
namespace editor {

namespace {

void styleCombo(juce::ComboBox& c)
{
    c.setColour(juce::ComboBox::backgroundColourId, theme::bg);
    c.setColour(juce::ComboBox::outlineColourId,    theme::lzBorderMid);
    c.setColour(juce::ComboBox::textColourId,       theme::fg);
    c.setColour(juce::ComboBox::arrowColourId,      theme::fg.withAlpha(0.5f));
}

void populate(juce::ComboBox& c, const juce::StringArray& items)
{
    int id = 1;
    for (const auto& item : items) c.addItem(item, id++);
}

void styleSlider(juce::Slider& s)
{
    s.setColour(juce::Slider::trackColourId,    theme::olive.withAlpha(0.6f));
    s.setColour(juce::Slider::backgroundColourId, theme::lzBorder);
    s.setColour(juce::Slider::thumbColourId,    theme::olive);
    s.setColour(juce::Slider::textBoxTextColourId, theme::fg);
    s.setColour(juce::Slider::textBoxOutlineColourId, juce::Colours::transparentBlack);
    s.setColour(juce::Slider::textBoxBackgroundColourId, theme::bg);
    s.textFromValueFunction = [](double v) { return juce::String(v, 2); };
    s.setTextBoxStyle(juce::Slider::TextBoxRight, false, 48, theme::rowHeight);
    s.updateText();
}

}  // namespace

VoicingView::VoicingView(plugin::OedipaProcessor& p)
    : processor_(p),
      voiceAtt_  (p.getApvts(), plugin::pid::voicing,      voiceCombo_),
      chordAtt_  (p.getApvts(), plugin::pid::chordQuality, chordCombo_),
      rhythmAtt_ (p.getApvts(), plugin::pid::rhythm,       rhythmCombo_),
      arpAtt_    (p.getApvts(), plugin::pid::arp,          arpCombo_),
      lenAtt_    (p.getApvts(), plugin::pid::turingLength, lenSlider_),
      lockAtt_   (p.getApvts(), plugin::pid::turingLock,   lockSlider_)
{
    populate(voiceCombo_,  plugin::voicingChoices);
    populate(chordCombo_,  plugin::chordQualityChoices);
    populate(rhythmCombo_, plugin::rhythmChoices);
    populate(arpCombo_,    plugin::arpChoices);

    // ComboBoxAttachment was constructed (init list) BEFORE populate, so its
    // initial sync ran on an empty combo and left no selection. Manually
    // pull the APVTS choice index now that items exist; subsequent attachment
    // round-tripping handles all later edits in either direction.
    auto& apvts = processor_.getApvts();
    auto syncChoice = [&apvts](juce::ComboBox& c, const char* pid) {
        const int idx = (int) *apvts.getRawParameterValue(pid);
        c.setSelectedItemIndex(idx, juce::dontSendNotification);
    };
    syncChoice(voiceCombo_,  plugin::pid::voicing);
    syncChoice(chordCombo_,  plugin::pid::chordQuality);
    syncChoice(rhythmCombo_, plugin::pid::rhythm);
    syncChoice(arpCombo_,    plugin::pid::arp);

    for (auto* c : { &voiceCombo_, &chordCombo_, &rhythmCombo_, &arpCombo_ }) {
        styleCombo(*c);
        addAndMakeVisible(*c);
    }
    styleSlider(lenSlider_);
    styleSlider(lockSlider_);
    addChildComponent(lenSlider_);
    addChildComponent(lockSlider_);

    startTimerHz(15);
}

VoicingView::~VoicingView() { stopTimer(); }

int VoicingView::preferredHeight() const
{
    int rows = 4;  // VOICE, CHORD, RHYTHM, ARP
    if (lastTuringVisible_) rows += 2;
    return theme::groupPadY * 2
         + (int) theme::fsSm + theme::rowGap
         + theme::rowHeight * rows + theme::rowGap * (rows - 1);
}

void VoicingView::paint(juce::Graphics& g)
{
    g.fillAll(theme::bg);
    g.setColour(theme::lzBorder);
    g.drawRect(getLocalBounds(), 1);

    g.setFont(theme::dataFont(theme::fsSm, true));
    g.setColour(theme::fg.withAlpha(0.4f));
    g.drawText("VOICING", theme::groupPadX + 4, theme::groupPadY,
               getWidth() - theme::groupPadX * 2,
               (int) theme::fsSm + 2, juce::Justification::topLeft);

    const int labelW = 56;
    const int rowY0 = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2;

    g.setFont(theme::dataFont(theme::fsMd, true));
    g.setColour(theme::fg.withAlpha(0.6f));
    int row = 0;
    for (const char* lbl : { "VOICE", "CHORD", "RHYTHM", "ARP" }) {
        g.drawText(lbl,
                   theme::groupPadX,
                   rowY0 + row * (theme::rowHeight + theme::rowGap),
                   labelW, theme::rowHeight, juce::Justification::centredLeft);
        ++row;
    }
    if (lastTuringVisible_) {
        for (const char* lbl : { "LEN", "LOCK" }) {
            g.drawText(lbl,
                       theme::groupPadX,
                       rowY0 + row * (theme::rowHeight + theme::rowGap),
                       labelW, theme::rowHeight, juce::Justification::centredLeft);
            ++row;
        }
    }
}

void VoicingView::resized()
{
    const int labelW = 56;
    const int rowY0 = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2;
    const int ctlX = theme::groupPadX + labelW;
    const int ctlW = getWidth() - theme::groupPadX * 2 - labelW;

    auto place = [&](juce::Component& c, int row) {
        c.setBounds(ctlX, rowY0 + row * (theme::rowHeight + theme::rowGap),
                    ctlW, theme::rowHeight);
    };
    place(voiceCombo_,  0);
    place(chordCombo_,  1);
    place(rhythmCombo_, 2);
    place(arpCombo_,    3);
    place(lenSlider_,   4);
    place(lockSlider_,  5);
}

void VoicingView::timerCallback()
{
    const int rIdx = (int) *processor_.getApvts().getRawParameterValue(plugin::pid::rhythm);
    // "turing" is at index 5 in rhythmChoices.
    const bool turing = rIdx == 5;
    if (turing != lastTuringVisible_) {
        lastTuringVisible_ = turing;
        lenSlider_ .setVisible(turing);
        lockSlider_.setVisible(turing);
        // Notify the rail to re-stack: our parent here is the rail's
        // inner `content_` (a plain Component) whose `resized` is a
        // no-op — same trap that hid AnchorsView's row rebuild.
        if (onTuringVisibilityChanged) onTuringVisibilityChanged();
        repaint();
    }
}

}  // namespace editor
}  // namespace oedipa
