// Interactive Tonnetz lattice — the centerpiece UI per ADR 008 §UI.
//
// Renders 48 triangles (7×5 vertices) and dispatches mouse / long-press
// gestures into the engine's PointerInteraction state machine, then routes
// the resulting outcomes back into the processor (startChord update, drag
// sequence writeback, anchor add). MIDI preview and walk-trail rendering
// live here too.
//
// Logic vs renderer split (per CLAUDE.md "GUI / UI components"):
//   • Lattice geometry, hit-test, drag resolver, and pointer state machine
//     all live under Source/Engine/ and are unit-tested in isolation.
//   • This component is the renderer + JUCE-event glue. Tested via a small
//     surface (handleOutcomeForTest) that exercises the writeback path.

#pragma once

#include "Engine/Lattice.h"
#include "Engine/PointerInteraction.h"
#include "Engine/Tonnetz.h"
#include "Plugin/PluginProcessor.h"

#include <juce_gui_basics/juce_gui_basics.h>

#include <vector>

namespace oedipa {
namespace editor {

class LatticeView : public juce::Component, private juce::Timer
{
public:
    explicit LatticeView(plugin::OedipaProcessor&);
    ~LatticeView() override;

    void paint(juce::Graphics&) override;
    void resized() override;

    void mouseDown(const juce::MouseEvent&) override;
    void mouseDrag(const juce::MouseEvent&) override;
    void mouseUp(const juce::MouseEvent&) override;
    void mouseExit(const juce::MouseEvent&) override;

    // Test surface — drives the same writeback path as a real pointer
    // outcome without needing to synthesise a juce::MouseEvent. Phase 4
    // unit tests cover hit-test (test_Lattice) and the state machine
    // (test_PointerInteraction) in isolation; this is the glue layer.
    void handleOutcomeForTest(const engine::PointerOutcome&);

private:
    void timerCallback() override;
    void rebuildTrianglesIfStale();
    void handleOutcome(const engine::PointerOutcome&);

    juce::AffineTransform latticeToComponent() const;
    juce::Point<float> componentToLattice(juce::Point<float>) const;

    plugin::OedipaProcessor& processor_;

    std::vector<engine::Triangle> triangles_;
    engine::PitchClass cachedCenterPc_ = -1;

    engine::PointerInteraction interaction_;
    int lastEnteredTri_ = -1;

    // Timer-driven repaint diff state. The timer wakes 15× / s and only
    // schedules a repaint when the playhead boundary (substep / spt) or the
    // start chord changes. Without this gate, a 60 Hz unconditional repaint
    // stacks on top of JUCE's resize-driven paints during corner drag and
    // produces visible flicker on the lattice.
    int lastDrawnSubStep_ = -2;
    engine::PitchClass lastDrawnCenterPc_ = -1;

    // Lattice timestamp for PointerInteraction's long-press timer. Wall
    // time would also work; juce::Time::getMillisecondCounter is monotonic
    // enough for this scope and easy to drive from tests via offsets.
    static double currentTimeMs();

    JUCE_DECLARE_NON_COPYABLE_WITH_LEAK_DETECTOR(LatticeView)
};

}  // namespace editor
}  // namespace oedipa
