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
    // Known issue: corner-resize in Logic Pro on macOS Tahoe makes the
    // editor's height oscillate by ~50 px during a single drag, even
    // when cursor.x moves smoothly. Diagnosed against this build:
    // MouseEvent::getDistanceFromDragStartY does not increase
    // monotonically under the OS event stream Logic delivers — the JUCE
    // corner faithfully reflects the noisy Y deltas it gets.
    // Upstream is Apple/Logic, not JUCE; community thread:
    //   https://forum.juce.com/t/glitchy-resizing-in-logic-pro-on-macos-tahoe/67529
    // Affected matrix: macOS Tahoe (26.x) × Logic Pro (11.2+ / 12.x) ×
    // every JUCE version reported (≤ 8.0.10). No JUCE-level workaround
    // exists; symptom is expected to disappear when Apple fixes it.
    // Other in-scope hosts (Logic on pre-Tahoe, Cubase, Reaper, Bitwig,
    // Standalone) are unaffected — do NOT add a Tahoe-only mitigation
    // that would degrade resize feel everywhere else.
    setResizable(true, true);
    setResizeLimits(640, 360, 1800, 1200);
    // Edge-drag resize was attempted via `ResizableBorderComponent` but
    // is incompatible with the AU plugin context: dragging top/left
    // changes the editor's (x, y) origin within EditorCompHolder, but
    // the host NSView frame only follows the size — leaving the editor
    // visibly offset inside a larger host window. Bottom-right corner
    // resize via the auto-corner stays as the only resize affordance
    // until JUCE provides a host-aware edge resizer.
    setSize(900, 540);
}

void OedipaEditor::paint(juce::Graphics& g)
{
    g.fillAll(theme::bg);

    // Header row: Oedipa title, divider below. The × dismiss from
    // inboil's TonnetzSheet doesn't apply — the host owns plugin window
    // lifecycle in VST/AU; an explicit × would either be a no-op
    // (confusing) or call host-internal close (unsupported).
    const int hh = theme::headerHeight;
    g.setColour(theme::fg);
    g.setFont(theme::dataFont(theme::fsLg, true));
    g.drawText("Oedipa", theme::railPad, 0,
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
}

}  // namespace editor
}  // namespace oedipa
