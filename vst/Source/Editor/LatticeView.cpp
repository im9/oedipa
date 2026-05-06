#include "Editor/LatticeView.h"

#include "Editor/DiagLog.h"
#include "Editor/Theme.h"
#include "Engine/Walker.h"
#include "Plugin/Parameters.h"

#include <algorithm>
#include <array>

namespace oedipa {
namespace editor {

namespace {

// Inboil palette via Editor/Theme.h. Major triangles render as cream-on-
// cream (--dz-divider over --color-bg, near-invisible) and minor as a
// faint navy tint (--lz-divider) — same near-monochrome lattice inboil
// renders against its cream sheet.
const juce::Colour kBg            = theme::bg;
const juce::Colour kFg            = theme::fg;
const juce::Colour kMajorFill     = theme::bg;                       // dz-divider over bg ≈ bg
const juce::Colour kMinorFill     = theme::lzDivider.overlaidWith(theme::bg);
const juce::Colour kCurrentFill   = theme::olive;
const juce::Colour kPlayingFill   = juce::Colours::white;
const juce::Colour kWalkFill      = theme::oliveBg;
const juce::Colour kStroke        = theme::fg;
const juce::Colour kWalkTrail     = theme::olive.withAlpha(0.30f);
const juce::Colour kAnchor        = theme::salmon;
const juce::Colour kChordTrailBg  = theme::bg;
const juce::Colour kChordTrailDim = theme::fg.withAlpha(0.35f);

constexpr float kChordTrailHeight = 22.0f;

// Visualization horizon: how many transform boundaries to walk forward when
// computing the walk-trail polyline. Earlier 16 produced long diagonal
// strokes that cut across unrelated cells (the polyline connects
// non-adjacent centroids in walker order, not cell-edge order). User
// feedback: "lines from behind". Cap at 4 so the trail stays close to
// the current chord's neighbourhood rather than slashing across the
// whole lattice.
constexpr int kWalkHorizonBoundaries = 4;

// Chord-trail history shown to the LEFT of the playing chord during
// playback. Past chords dimmed; current at the right edge.
constexpr int kChordTrailHistoryMax = 8;

std::array<engine::PitchClass, 3> sortPcs(engine::Triad t)
{
    std::array<engine::PitchClass, 3> pcs{
        ((t[0] % 12) + 12) % 12,
        ((t[1] % 12) + 12) % 12,
        ((t[2] % 12) + 12) % 12,
    };
    std::sort(pcs.begin(), pcs.end());
    return pcs;
}

}  // namespace

LatticeView::LatticeView(plugin::OedipaProcessor& p)
    : processor_(p)
{
    setOpaque(true);
    setMouseCursor(juce::MouseCursor::PointingHandCursor);
    // 15 Hz is enough for both the long-press tick (~250 ms threshold) and
    // the walk-state animation (chord boundaries fire at most every spt
    // sub-steps ≈ a quarter note). 60 Hz produced visible flicker during
    // corner-drag resize because it stacked on JUCE's resize-driven paints.
    startTimerHz(15);
}

LatticeView::~LatticeView()
{
    stopTimer();
}

void LatticeView::resized()
{
    OEDIPA_DIAG_LOG(juce::String::formatted(
        "lattice.resize t=%u %dx%d",
        (unsigned int) juce::Time::getMillisecondCounter(),
        getWidth(), getHeight()));
}

void LatticeView::rebuildTrianglesIfStale()
{
    const auto pc = ((processor_.getStartChord()[0] % 12) + 12) % 12;
    if (pc != cachedCenterPc_ || triangles_.empty()) {
        triangles_ = engine::buildTriangles(pc);
        cachedCenterPc_ = pc;
    }
}

double LatticeView::currentTimeMs()
{
    return (double) juce::Time::getMillisecondCounter();
}

juce::AffineTransform LatticeView::latticeToComponent() const
{
    const float lw = engine::latticeWidth();
    const float lh = engine::latticeHeight();
    const float bw = (float) getWidth();
    const float bh = (float) getHeight();
    if (lw <= 0 || lh <= 0 || bw <= 0 || bh <= 0) return {};

    // Reserve space at the top for the chord-trail strip.
    const float availH = std::max(1.0f, bh - kChordTrailHeight);
    const float scale = std::min(bw / lw, availH / lh);
    const float drawnW = lw * scale;
    const float offX = (bw - drawnW) * 0.5f;
    // Anchor the lattice top just below the chord-trail strip rather than
    // vertically centring the drawn area. Centring made offY swing ~90 px
    // in 24 ms during a corner drag (diag log: 144 → 53 → 46) even though
    // drawnH barely moved (406 → 411 → 412), which read as flicker because
    // the whole lattice translated upward each frame the window shrank.
    // Top-anchoring keeps offY constant for any given scale, so resizing
    // shrinks/grows the empty area below without moving the lattice.
    const float offY = kChordTrailHeight;
    return juce::AffineTransform::scale(scale, scale).translated(offX, offY);
}

juce::Point<float> LatticeView::componentToLattice(juce::Point<float> p) const
{
    const auto t = latticeToComponent();
    juce::AffineTransform inv = t.inverted();
    juce::Point<float> out = p;
    out.applyTransform(inv);
    return out;
}

void LatticeView::paint(juce::Graphics& g)
{
    g.fillAll(kBg);

    const_cast<LatticeView*>(this)->rebuildTrianglesIfStale();
    if (triangles_.empty()) return;

#if OEDIPA_DIAG
    {
        const float bw_dbg = (float) getWidth();
        const float bh_dbg = (float) getHeight();
        const float availH_dbg = std::max(1.0f, bh_dbg - kChordTrailHeight);
        const float lw_dbg = engine::latticeWidth();
        const float lh_dbg = engine::latticeHeight();
        const float scale_dbg = std::min(bw_dbg / lw_dbg, availH_dbg / lh_dbg);
        const float drawnH_dbg = lh_dbg * scale_dbg;
        const float offY_dbg = kChordTrailHeight + (availH_dbg - drawnH_dbg) * 0.5f;
        const int   lastSub_dbg = processor_.getLastSubStep();
        OEDIPA_DIAG_LOG(juce::String::formatted(
            "paint t=%u bw=%d bh=%d availH=%.1f scale=%.4f drawnH=%.1f offY=%.1f lastSub=%d",
            (unsigned int) juce::Time::getMillisecondCounter(),
            getWidth(), getHeight(),
            availH_dbg, scale_dbg, drawnH_dbg, offY_dbg,
            lastSub_dbg));
    }
#endif

    const auto startPcs   = sortPcs(processor_.getStartChord());
    const auto walkState  = processor_.makeWalkStateSnapshot();
    const int  lastSubStep = processor_.getLastSubStep();
    const int  spt        = std::max(1, walkState.stepsPerTransform);

    // Walk path = chord PCs at each transform boundary out to the horizon.
    std::vector<std::array<engine::PitchClass, 3>> walkPcs;
    walkPcs.reserve((std::size_t) (kWalkHorizonBoundaries + 1));
    for (int i = 0; i <= kWalkHorizonBoundaries; ++i) {
        const auto chord = engine::walk(walkState, i * spt);
        walkPcs.push_back(sortPcs(chord));
    }

    // "Playing" PCs from current playhead position. -1 = stopped.
    const int currentBoundary = (lastSubStep >= 0) ? (lastSubStep / spt) : -1;
    const bool isPlaying = currentBoundary >= 0;

    auto stateOf = [&](const engine::Triangle& tri) -> int {
        // 3 = playing, 2 = current, 1 = walk, 0 = none
        if (isPlaying && currentBoundary < (int) walkPcs.size()
            && tri.notes == walkPcs[(std::size_t) currentBoundary]) {
            return 3;
        }
        if (tri.notes == startPcs) return 2;
        for (const auto& w : walkPcs) {
            if (tri.notes == w) return 1;
        }
        return 0;
    };

    const auto xform = latticeToComponent();

    // Walk trail polyline through walked-cell centroids (low-opacity).
    juce::Path trail;
    bool started = false;
    for (const auto& wp : walkPcs) {
        for (const auto& tri : triangles_) {
            if (tri.notes == wp) {
                juce::Point<float> c{tri.centroid.x, tri.centroid.y};
                c.applyTransform(xform);
                if (! started) { trail.startNewSubPath(c); started = true; }
                else            { trail.lineTo(c); }
                break;
            }
        }
    }
    if (started) {
        g.setColour(kWalkTrail);
        g.strokePath(trail, juce::PathStrokeType(2.0f));
    }

    // Triangles + labels.
    g.setFont(juce::Font(juce::FontOptions(11.0f).withStyle("Bold")));
    for (const auto& tri : triangles_) {
        const int s = stateOf(tri);
        juce::Path path;
        juce::Point<float> v0{tri.vertices[0].x, tri.vertices[0].y};
        juce::Point<float> v1{tri.vertices[1].x, tri.vertices[1].y};
        juce::Point<float> v2{tri.vertices[2].x, tri.vertices[2].y};
        v0.applyTransform(xform);
        v1.applyTransform(xform);
        v2.applyTransform(xform);
        path.startNewSubPath(v0);
        path.lineTo(v1);
        path.lineTo(v2);
        path.closeSubPath();

        juce::Colour fill = (tri.quality == engine::Quality::Major) ? kMajorFill : kMinorFill;
        if (s == 1) fill = kWalkFill;
        if (s == 2) fill = kCurrentFill;
        if (s == 3) fill = kPlayingFill;
        g.setColour(fill);
        g.fillPath(path);
        g.setColour(kStroke);
        g.strokePath(path, juce::PathStrokeType(0.5f));

        juce::Point<float> centroid{tri.centroid.x, tri.centroid.y};
        centroid.applyTransform(xform);
        const auto labelColour = (s == 2) ? kBg : kFg;
        g.setColour(labelColour);
        g.drawText(engine::labelFor(tri.rootPc, tri.quality),
                   (int) (centroid.x - 20), (int) (centroid.y - 8), 40, 14,
                   juce::Justification::centred);
    }

    // Anchor markers were a salmon pill with the step number drawn on each
    // anchored cell. Per UX feedback the badge read as a "mystery number"
    // (the step value has no inherent visual meaning when isolated) and
    // cluttered the lattice without surfacing what an "anchor" is. Removed
    // from the lattice; the right-rail AnchorsView still lists every
    // anchor with step + chord so the data is one click away.

    // Chord-trail overlay (top strip) — only during playback.
    if (isPlaying && currentBoundary < (int) walkPcs.size()) {
        g.setColour(kChordTrailBg);
        g.fillRect(0.0f, 0.0f, (float) getWidth(), kChordTrailHeight);
        g.setFont(juce::Font(juce::FontOptions(13.0f).withStyle("Bold")));
        const int start = std::max(0, currentBoundary - kChordTrailHistoryMax);
        float x = 8.0f;
        for (int i = start; i <= currentBoundary; ++i) {
            for (const auto& tri : triangles_) {
                if (tri.notes == walkPcs[(std::size_t) i]) {
                    g.setColour(i == currentBoundary ? kFg : kChordTrailDim);
                    juce::String label{engine::labelFor(tri.rootPc, tri.quality)};
                    g.drawText(label, (int) x, 4, 40, 16, juce::Justification::centredLeft);
                    x += 32.0f;
                    if (i < currentBoundary) {
                        g.setColour(kChordTrailDim);
                        g.drawText(">", (int) x, 4, 12, 16, juce::Justification::centredLeft);
                        x += 12.0f;
                    }
                    break;
                }
            }
        }
    }
}

void LatticeView::mouseDown(const juce::MouseEvent& e)
{
    rebuildTrianglesIfStale();
    const auto p = componentToLattice(e.position);
    const int idx = engine::triangleAt(p.x, p.y, triangles_);
    if (idx < 0) return;
    interaction_.onPress(idx, currentTimeMs());
    lastEnteredTri_ = idx;
}

void LatticeView::mouseDrag(const juce::MouseEvent& e)
{
    if (! interaction_.isPressed()) return;
    const auto p = componentToLattice(e.position);
    const int idx = engine::triangleAt(p.x, p.y, triangles_);
    if (idx < 0 || idx == lastEnteredTri_) return;
    interaction_.onEnter(idx);
    lastEnteredTri_ = idx;
}

void LatticeView::mouseUp(const juce::MouseEvent&)
{
    auto outcome = interaction_.onRelease();
    lastEnteredTri_ = -1;
    if (outcome) handleOutcome(*outcome);
    repaint();
}

void LatticeView::mouseExit(const juce::MouseEvent&)
{
    if (! interaction_.isPressed()) return;
    auto outcome = interaction_.onRelease();
    lastEnteredTri_ = -1;
    if (outcome) handleOutcome(*outcome);
    repaint();
}

void LatticeView::timerCallback()
{
    if (interaction_.isPressed()) {
        if (auto anchor = interaction_.onTick(currentTimeMs())) {
            handleOutcome(*anchor);
        }
        // Press-state animation (long-press progress hint via downstream
        // interaction state) wants a fresh paint each tick; resize-time
        // flicker doesn't apply when the user is holding the lattice.
        repaint();
        return;
    }

    // Otherwise, only repaint when the visual state actually changed:
    // the chord boundary advanced, or the start chord moved (centerPc).
    // JUCE's own size-change paints handle the resize case, so we don't
    // need to paint on every tick.
    const int  spt        = std::max(1, (int) *processor_.getApvts().getRawParameterValue(plugin::pid::stepsPerTransform));
    const int  lastSubStep = processor_.getLastSubStep();
    const int  boundary   = (lastSubStep >= 0) ? (lastSubStep / spt) : -1;
    const auto centerPc   = ((processor_.getStartChord()[0] % 12) + 12) % 12;
    if (boundary != lastDrawnSubStep_ || centerPc != lastDrawnCenterPc_) {
        lastDrawnSubStep_  = boundary;
        lastDrawnCenterPc_ = centerPc;
        repaint();
    }
}

void LatticeView::handleOutcome(const engine::PointerOutcome& out)
{
    rebuildTrianglesIfStale();
    if (triangles_.empty()) return;

    switch (out.kind) {
        case engine::PointerOutcome::Kind::Tap: {
            if (out.path.empty()) return;
            const int idx = out.path.front();
            if (idx < 0 || idx >= (int) triangles_.size()) return;
            const auto& tri = triangles_[(std::size_t) idx];
            const auto chord = engine::rebuildTriadInOctave(tri.notes, processor_.getStartChord()[0]);
            processor_.setStartChord(chord);
            processor_.requestPreview(chord);
            break;
        }
        case engine::PointerOutcome::Kind::Drag: {
            if (out.path.size() < 2) return;
            std::vector<std::array<engine::PitchClass, 3>> pathPcs;
            pathPcs.reserve(out.path.size());
            for (int idx : out.path) {
                if (idx < 0 || idx >= (int) triangles_.size()) return;
                pathPcs.push_back(triangles_[(std::size_t) idx].notes);
            }
            const auto resolution = engine::resolveDragPath(pathPcs, processor_.getStartChord()[0]);
            processor_.applyDragResolution(resolution.newStartChord, resolution.ops);
            break;
        }
        case engine::PointerOutcome::Kind::Anchor: {
            if (out.path.empty()) return;
            const int idx = out.path.front();
            if (idx < 0 || idx >= (int) triangles_.size()) return;
            const auto& tri = triangles_[(std::size_t) idx];
            processor_.addAnchorAtNextStep(tri.rootPc, tri.quality);
            break;
        }
    }
}

void LatticeView::handleOutcomeForTest(const engine::PointerOutcome& out)
{
    handleOutcome(out);
}

}  // namespace editor
}  // namespace oedipa
