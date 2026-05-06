// Single source for editor palette + typography (ADR 008 §Phase 5).
// All Editor/* views must read colours and fonts from here — literal
// hex / px values in views are a review blocker. Mirrors inboil's
// app.css tokens; iOS UI will need its own translation layer because
// these tokens are JUCE-typed.

#pragma once

#include <juce_graphics/juce_graphics.h>

namespace oedipa {
namespace editor {
namespace theme {

// ── Inboil palette (app.css :root) ───────────────────────────────
const juce::Colour bg     = juce::Colour::fromRGB(0xED, 0xE8, 0xDC);
const juce::Colour fg     = juce::Colour::fromRGB(0x1E, 0x20, 0x28);
const juce::Colour olive  = juce::Colour::fromRGB(0x78, 0x78, 0x45);
const juce::Colour blue   = juce::Colour::fromRGB(0x44, 0x72, 0xB4);
const juce::Colour salmon = juce::Colour::fromRGB(0xE8, 0xA0, 0x90);

// fg-on-bg overlays. Alpha values are inboil's --lz-* / --olive-bg /
// --dz-* opacities, not freely tweakable: the visual hierarchy was
// tuned in inboil and we mirror it 1:1.
inline juce::Colour fgAlpha(float a)    { return fg.withAlpha(a); }
inline juce::Colour oliveAlpha(float a) { return olive.withAlpha(a); }
inline juce::Colour bgAlpha(float a)    { return bg.withAlpha(a); }

const auto lzDivider     = fgAlpha(0.06f);
const auto lzBgHover     = fgAlpha(0.06f);
const auto lzBgActive    = fgAlpha(0.08f);
const auto lzBorder      = fgAlpha(0.10f);
const auto lzBorderMid   = fgAlpha(0.12f);
const auto lzBorderStrong= fgAlpha(0.15f);
const auto oliveBg       = oliveAlpha(0.15f);
const auto oliveBgSubtle = oliveAlpha(0.08f);

// ── Type scale (inboil --fs-*) ───────────────────────────────────
constexpr float fsSm = 9.0f;   // group legends
constexpr float fsMd = 10.0f;  // control labels
constexpr float fsLg = 11.0f;  // values, primary labels

// JetBrains Mono if installed, monospace otherwise. Fallback chain
// matches inboil --font-data.
juce::Font dataFont(float pointSize, bool bold = false);

// ── Layout tokens (right rail, header) ───────────────────────────
constexpr int railWidth   = 280;
constexpr int headerHeight= 32;
constexpr int rowHeight   = 22;
constexpr int rowGap      = 4;
constexpr int groupGap    = 8;
constexpr int groupPadX   = 8;
constexpr int groupPadY   = 6;
constexpr int railPad     = 12;

}  // namespace theme
}  // namespace editor
}  // namespace oedipa
