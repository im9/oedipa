#include "Editor/RightRailView.h"

#include "Editor/Theme.h"

#include <algorithm>

namespace oedipa {
namespace editor {

RightRailView::RightRailView(plugin::OedipaProcessor& p)
    : processor_(p),
      slots_(p),
      sequenceRow_(p, drawer_),
      sequenceDrawer_(p, drawer_),
      voicing_(p),
      anchors_(p),
      output_(p),
      preset_(p)
{
    addAndMakeVisible(viewport_);
    viewport_.setViewedComponent(&content_, false);
    viewport_.setScrollBarsShown(true, false);

    content_.addAndMakeVisible(slots_);
    content_.addAndMakeVisible(sequenceRow_);
    content_.addAndMakeVisible(sequenceDrawer_);
    content_.addAndMakeVisible(voicing_);
    content_.addAndMakeVisible(anchors_);
    content_.addAndMakeVisible(output_);
    content_.addAndMakeVisible(preset_);

    sequenceRow_.onDrawerStateChanged           = [this] { relayout(); };
    anchors_     .onAnchorsChanged              = [this] { relayout(); };
    voicing_     .onTuringVisibilityChanged     = [this] { relayout(); };
}

void RightRailView::paint(juce::Graphics& g)
{
    g.fillAll(theme::bg);
    // 1px border-left mirroring inboil's `.tonnetz-controls` divider.
    g.setColour(theme::lzBorder);
    g.drawLine((float) 0, 0.0f, (float) 0, (float) getHeight(), 1.0f);
}

void RightRailView::resized()
{
    viewport_.setBounds(getLocalBounds());
    relayout();
}

void RightRailView::relayout()
{
    const int w = std::max(0, viewport_.getWidth() - viewport_.getScrollBarThickness());
    const int pad = theme::railPad;
    const int gap = theme::groupGap;

    auto place = [&](juce::Component& c, int& y, int h) {
        if (h <= 0) {
            c.setVisible(false);
            return;
        }
        c.setVisible(true);
        c.setBounds(pad, y, w - pad * 2, h);
        y += h + gap;
    };

    int y = pad;
    place(slots_,           y, slots_.preferredHeight());
    place(sequenceRow_,     y, sequenceRow_.preferredHeight());
    place(sequenceDrawer_,  y, sequenceDrawer_.preferredHeight());
    place(voicing_,         y, voicing_.preferredHeight());
    place(anchors_,         y, anchors_.preferredHeight());
    place(output_,          y, output_.preferredHeight());
    place(preset_,          y, preset_.preferredHeight());

    content_.setSize(w, std::max(y, viewport_.getHeight()));
}

}  // namespace editor
}  // namespace oedipa
