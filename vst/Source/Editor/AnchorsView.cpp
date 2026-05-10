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
// changed" — avoids comparing struct-by-struct across rebuilds. 64-bit
// width: with the previous int (32-bit), the multiplier-and-add chain
// could collide for distinct anchor lists at the size-hash bit budget,
// allowing a real mutation to look like no-change and freeze the rebuild
// until something else perturbed the size guard.
std::uint64_t anchorVersionOf(const std::vector<engine::Anchor>& as)
{
    std::uint64_t h = (std::uint64_t) as.size() * 1000003ULL;
    for (const auto& a : as) {
        h = h * 33ULL + (std::uint64_t) (std::uint32_t) a.step;
        h = h * 33ULL + (std::uint64_t) (std::uint32_t) a.rootPc;
        h = h * 33ULL + (a.quality == engine::Quality::Minor ? 1ULL : 0ULL);
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
    const std::uint64_t v = anchorVersionOf(anchors);
    if (v == lastVersion_ && anchors.size() == lastAnchorCount_) return;
    lastVersion_ = v;
    lastAnchorCount_ = anchors.size();
    rebuildRows();
    // Notify the rail to re-stack groups: AnchorsView's preferredHeight is
    // 0 when empty and grows with anchor count, so the rail must relayout
    // to give us a non-zero rect (which then triggers our `resized` and
    // positions the new TextEditor / Label / × button child rows).
    // Earlier impl called `getParentComponent()->resized()` — but our
    // parent is the rail's inner `content_` (a plain Component), whose
    // default `resized` is a no-op, so the rebuild was visually invisible.
    if (onAnchorsChanged) onAnchorsChanged();
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
        // Colour + font BEFORE setText: juce::TextEditor stores colour
        // per-character at insertion time, so setText with a stale default
        // colour would lock the digits to whatever the LookAndFeel_V4
        // default textColour is (a near-white in the V4 dark scheme — the
        // origin of the "white digits on cream" rendering reported on the
        // anchor row 2026-05-11). Setting colours first, then setFont,
        // then setText keeps the per-character colour in sync with the
        // theme.
        r.stepEditor->setColour(juce::TextEditor::backgroundColourId, theme::bg);
        r.stepEditor->setColour(juce::TextEditor::textColourId,       theme::fg);
        // Outline demoted from salmon to the rail's standard subtle border:
        // baseline rendering shouldn't read as "highlighted/active" — that
        // accent is reserved for the future "anchor at current playhead"
        // state. Mirrors VoicingView's ComboBox outlineColourId which uses
        // the same lzBorderMid token.
        r.stepEditor->setColour(juce::TextEditor::outlineColourId,        theme::lzBorderMid);
        r.stepEditor->setColour(juce::TextEditor::focusedOutlineColourId, theme::lzBorderStrong);
        r.stepEditor->setFont(theme::dataFont(theme::fsMd, false));
        r.stepEditor->setText(juce::String(anchors[(std::size_t) i].step), juce::dontSendNotification);
        // Force the per-character colour storage to theme::fg regardless
        // of the colour that was active at insertion time. juce::TextEditor
        // stores font + colour per character at insertion; if anything in
        // the construction order leaves the stored colour stale (LookAndFeel
        // default, race with caret recreation, format-specific wrapper
        // ordering — VST3/CLAP rendered the digits white where AU rendered
        // them dark, 2026-05-11), this rewrites every glyph to fg.
        r.stepEditor->applyColourToAllText(theme::fg, true);
        const int idx = i;
        // SafePointer guards the editor pointer against the rebuildRows
        // path: removeAnchor / writeStep call setAnchors → next timer tick
        // detects the version change and runs rebuildRows, destroying the
        // current TextEditor instances. A focus-lost event dispatched
        // during that destruction window would otherwise dereference a
        // freed editor via the captured raw pointer.
        juce::Component::SafePointer<juce::TextEditor> safeEditor{r.stepEditor.get()};
        r.stepEditor->onReturnKey = [this, idx, safeEditor] {
            if (auto* te = safeEditor.getComponent()) {
                writeStep(idx, te->getText().getIntValue());
            }
        };
        r.stepEditor->onFocusLost = [this, idx, safeEditor] {
            if (auto* te = safeEditor.getComponent()) {
                writeStep(idx, te->getText().getIntValue());
            }
        };
        addAndMakeVisible(*r.stepEditor);

        r.chordLabel = std::make_unique<juce::Label>();
        r.chordLabel->setText(chordLabelFor(anchors[(std::size_t) i].rootPc,
                                            anchors[(std::size_t) i].quality),
                              juce::dontSendNotification);
        // Chord label is data-equivalent to the step number (step = "when",
        // chord = "what"); render in the same fg-token. salmon was an
        // accent-overuse that turned baseline data into highlight, with no
        // available state to demote into when the playhead actually crosses
        // the anchor.
        r.chordLabel->setColour(juce::Label::textColourId, theme::fg);
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
