#include "Editor/AnchorsView.h"

#include "Editor/Theme.h"
#include "Engine/Tonnetz.h"

#include <algorithm>

namespace oedipa {
namespace editor {

namespace {

const char* kNoteNames[] = {
    "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"
};

juce::String chordLabelFor(engine::PitchClass rootPc, engine::Quality q)
{
    return juce::String(kNoteNames[((rootPc % 12) + 12) % 12])
         + (q == engine::Quality::Minor ? "m" : "");
}

// Stable hash of the anchor list so the timer can detect "any field
// changed" — avoids comparing struct-by-struct across rebuilds.
int anchorVersionOf(const std::vector<engine::Anchor>& as)
{
    int h = (int) as.size() * 1000003;
    for (const auto& a : as) {
        h = h * 33 + a.step;
        h = h * 33 + (int) a.rootPc;
        h = h * 33 + (a.quality == engine::Quality::Minor ? 1 : 0);
    }
    return h;
}

}  // namespace

AnchorsView::AnchorsView(plugin::OedipaProcessor& p)
    : processor_(p)
{
    startTimerHz(15);
}

AnchorsView::~AnchorsView() { stopTimer(); }

int AnchorsView::preferredHeight() const
{
    const auto& anchors = processor_.getAnchors();
    if (anchors.empty()) return 0;
    const int rows = (int) anchors.size();
    return theme::groupPadY * 2
         + (int) theme::fsSm + theme::rowGap
         + theme::rowHeight * rows + theme::rowGap * (rows - 1);
}

void AnchorsView::paint(juce::Graphics& g)
{
    g.fillAll(theme::bg);
    g.setColour(theme::lzBorder);
    g.drawRect(getLocalBounds(), 1);

    g.setFont(theme::dataFont(theme::fsSm, true));
    g.setColour(theme::fg.withAlpha(0.4f));
    g.drawText("ANCHORS", theme::groupPadX + 4, theme::groupPadY,
               getWidth() - theme::groupPadX * 2,
               (int) theme::fsSm + 2, juce::Justification::topLeft);
}

void AnchorsView::resized()
{
    const int rowY0 = theme::groupPadY + (int) theme::fsSm + theme::rowGap + 2;
    const int stepW = 48;
    const int rmW   = 22;
    const int chordX = theme::groupPadX + stepW + 6;

    for (int i = 0; i < (int) rows_.size(); ++i) {
        const int y = rowY0 + i * (theme::rowHeight + theme::rowGap);
        if (rows_[(std::size_t) i].stepEditor) {
            rows_[(std::size_t) i].stepEditor->setBounds(theme::groupPadX, y, stepW, theme::rowHeight);
        }
        if (rows_[(std::size_t) i].chordLabel) {
            rows_[(std::size_t) i].chordLabel->setBounds(chordX, y,
                                                         getWidth() - chordX - rmW - theme::groupPadX - 4,
                                                         theme::rowHeight);
        }
        if (rows_[(std::size_t) i].removeBtn) {
            rows_[(std::size_t) i].removeBtn->setBounds(getWidth() - theme::groupPadX - rmW, y, rmW, theme::rowHeight);
        }
    }
}

void AnchorsView::timerCallback()
{
    const auto& anchors = processor_.getAnchors();
    const int v = anchorVersionOf(anchors);
    if (v == lastVersion_ && anchors.size() == lastAnchorCount_) return;
    lastVersion_ = v;
    lastAnchorCount_ = anchors.size();
    rebuildRows();
    if (auto* parent = getParentComponent()) parent->resized();
    repaint();
}

void AnchorsView::rebuildRows()
{
    for (auto& r : rows_) {
        if (r.stepEditor) removeChildComponent(r.stepEditor.get());
        if (r.chordLabel) removeChildComponent(r.chordLabel.get());
        if (r.removeBtn)  removeChildComponent(r.removeBtn.get());
    }
    rows_.clear();

    const auto anchors = processor_.getAnchors();
    rows_.reserve(anchors.size());
    for (int i = 0; i < (int) anchors.size(); ++i) {
        Row r;
        r.stepEditor = std::make_unique<juce::TextEditor>();
        r.stepEditor->setInputRestrictions(5, "0123456789");
        r.stepEditor->setText(juce::String(anchors[(std::size_t) i].step), juce::dontSendNotification);
        r.stepEditor->setColour(juce::TextEditor::backgroundColourId, theme::bg);
        r.stepEditor->setColour(juce::TextEditor::textColourId, theme::fg);
        r.stepEditor->setColour(juce::TextEditor::outlineColourId, theme::salmon.withAlpha(0.6f));
        r.stepEditor->setColour(juce::TextEditor::focusedOutlineColourId, theme::salmon);
        r.stepEditor->setFont(theme::dataFont(theme::fsMd, false));
        const int idx = i;
        r.stepEditor->onReturnKey = [this, idx, te = r.stepEditor.get()] {
            writeStep(idx, te->getText().getIntValue());
        };
        r.stepEditor->onFocusLost = [this, idx, te = r.stepEditor.get()] {
            writeStep(idx, te->getText().getIntValue());
        };
        addAndMakeVisible(*r.stepEditor);

        r.chordLabel = std::make_unique<juce::Label>();
        r.chordLabel->setText(chordLabelFor(anchors[(std::size_t) i].rootPc,
                                            anchors[(std::size_t) i].quality),
                              juce::dontSendNotification);
        r.chordLabel->setColour(juce::Label::textColourId, theme::salmon);
        r.chordLabel->setFont(theme::dataFont(theme::fsMd, true));
        addAndMakeVisible(*r.chordLabel);

        r.removeBtn = std::make_unique<juce::TextButton>(juce::CharPointer_UTF8("\xC3\x97"));  // ×
        r.removeBtn->setColour(juce::TextButton::buttonColourId, theme::bg);
        r.removeBtn->setColour(juce::TextButton::textColourOffId, theme::fg.withAlpha(0.6f));
        r.removeBtn->onClick = [this, idx] { removeAnchor(idx); };
        addAndMakeVisible(*r.removeBtn);

        rows_.push_back(std::move(r));
    }
}

void AnchorsView::writeStep(int idx, int value)
{
    auto anchors = processor_.getAnchors();
    if (idx < 0 || idx >= (int) anchors.size()) return;
    anchors[(std::size_t) idx].step = std::max(0, value);
    processor_.setAnchors(std::move(anchors));
    if (onAnchorsChanged) onAnchorsChanged();
}

void AnchorsView::removeAnchor(int idx)
{
    auto anchors = processor_.getAnchors();
    if (idx < 0 || idx >= (int) anchors.size()) return;
    anchors.erase(anchors.begin() + idx);
    processor_.setAnchors(std::move(anchors));
    if (onAnchorsChanged) onAnchorsChanged();
}

}  // namespace editor
}  // namespace oedipa
