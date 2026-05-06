#include "Editor/PluginEditor.h"

#include "Editor/DiagLog.h"
#include "Editor/Theme.h"

namespace oedipa {
namespace editor {

OedipaEditor::OedipaEditor(plugin::OedipaProcessor& p)
    : AudioProcessorEditor(&p), processor(p), lattice(p), rightRail(p)
{
    addAndMakeVisible(lattice);
    addAndMakeVisible(rightRail);
    setResizable(true, true);
    setResizeLimits(640, 360, 1800, 1200);
    setSize(900, 540);
}

void OedipaEditor::paint(juce::Graphics& g)
{
    g.fillAll(theme::bg);

    // Header row: TONNETZ title, divider below. The × dismiss from
    // inboil's TonnetzSheet doesn't apply — the host owns plugin window
    // lifecycle in VST/AU; an explicit × would either be a no-op
    // (confusing) or call host-internal close (unsupported).
    const int hh = theme::headerHeight;
    g.setColour(theme::fg);
    g.setFont(theme::dataFont(theme::fsLg, true));
    g.drawText("TONNETZ", theme::railPad, 0,
               getWidth() - theme::railPad * 2, hh,
               juce::Justification::centredLeft);

    g.setColour(theme::lzBorder);
    g.drawLine(0.0f, (float) hh, (float) getWidth(), (float) hh, 1.0f);
}

void OedipaEditor::resized()
{
    auto bounds = getLocalBounds();
    bounds.removeFromTop(theme::headerHeight);
    auto rail = bounds.removeFromRight(theme::railWidth);
    rightRail.setBounds(rail);
    lattice.setBounds(bounds);

    OEDIPA_DIAG_LOG(juce::String::formatted(
        "editor.resize t=%u %dx%d (lattice %dx%d, rail %dx%d)",
        (unsigned int) juce::Time::getMillisecondCounter(),
        getWidth(), getHeight(),
        lattice.getWidth(), lattice.getHeight(),
        rightRail.getWidth(), rightRail.getHeight()));
}

}  // namespace editor
}  // namespace oedipa
