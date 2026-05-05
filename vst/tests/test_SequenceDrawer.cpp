// SequenceDrawer state machine tests.
//
// Models the inline drawer that opens below the Sequence row when a SEQ
// pill is clicked (per ADR 008 §"Phase 5"). Pure index-tracking — the
// per-cell parameter values themselves live on the processor's `Cell`
// store; this object only manages "which cell is the user editing right
// now, if any."
//
// Behaviors covered:
//   • Starts closed.
//   • toggle(idx) on a closed drawer opens to that cell.
//   • toggle(idx) when already open at the same idx closes (re-tap to
//     dismiss is the inboil affordance for editor sheets).
//   • toggle(otherIdx) when open switches — does NOT close-then-open.
//   • close() always closes; idempotent.
//   • Sequence shrink past the selected index auto-closes (selected
//     cell no longer exists). Shrink that leaves the selection valid is
//     a no-op. Grow is always a no-op.

#include <catch2/catch_test_macros.hpp>

#include "Engine/SequenceDrawer.h"

using namespace oedipa::engine;

TEST_CASE("Drawer starts closed", "[drawer][initial]")
{
    SequenceDrawer d;
    CHECK_FALSE(d.isOpen());
    CHECK(d.selectedCell() == -1);
}

TEST_CASE("toggle on closed drawer opens at the requested cell", "[drawer][toggle]")
{
    SequenceDrawer d;
    d.toggle(3);
    CHECK(d.isOpen());
    CHECK(d.selectedCell() == 3);
}

TEST_CASE("toggle on the same cell while open closes", "[drawer][toggle]")
{
    SequenceDrawer d;
    d.toggle(3);
    d.toggle(3);
    CHECK_FALSE(d.isOpen());
    CHECK(d.selectedCell() == -1);
}

TEST_CASE("toggle on a different cell while open switches selection", "[drawer][toggle]")
{
    SequenceDrawer d;
    d.toggle(3);
    d.toggle(5);
    CHECK(d.isOpen());
    CHECK(d.selectedCell() == 5);
}

TEST_CASE("close() on an open drawer closes it", "[drawer][close]")
{
    SequenceDrawer d;
    d.toggle(2);
    d.close();
    CHECK_FALSE(d.isOpen());
    CHECK(d.selectedCell() == -1);
}

TEST_CASE("close() on a closed drawer is idempotent", "[drawer][close]")
{
    SequenceDrawer d;
    d.close();
    CHECK_FALSE(d.isOpen());
    d.close();
    CHECK_FALSE(d.isOpen());
}

TEST_CASE("Sequence shrink past selected cell auto-closes", "[drawer][length]")
{
    SequenceDrawer d;
    d.toggle(5);
    d.onSequenceLengthChanged(4);  // 5 is no longer a valid index
    CHECK_FALSE(d.isOpen());
    CHECK(d.selectedCell() == -1);
}

TEST_CASE("Sequence shrink to exactly the selected length closes (boundary)", "[drawer][length]")
{
    SequenceDrawer d;
    d.toggle(3);
    d.onSequenceLengthChanged(3);  // valid indices are 0..2; 3 is out of range
    CHECK_FALSE(d.isOpen());
}

TEST_CASE("Sequence shrink that leaves the selection valid does not close", "[drawer][length]")
{
    SequenceDrawer d;
    d.toggle(2);
    d.onSequenceLengthChanged(4);  // indices 0..3 still valid; 2 fits
    CHECK(d.isOpen());
    CHECK(d.selectedCell() == 2);
}

TEST_CASE("Sequence grow does not change drawer state", "[drawer][length]")
{
    SequenceDrawer d;
    d.toggle(1);
    d.onSequenceLengthChanged(8);
    CHECK(d.isOpen());
    CHECK(d.selectedCell() == 1);

    SequenceDrawer closed;
    closed.onSequenceLengthChanged(8);
    CHECK_FALSE(closed.isOpen());
}

TEST_CASE("Length change while closed is a no-op", "[drawer][length]")
{
    SequenceDrawer d;
    d.onSequenceLengthChanged(0);
    CHECK_FALSE(d.isOpen());
    d.onSequenceLengthChanged(8);
    CHECK_FALSE(d.isOpen());
}
