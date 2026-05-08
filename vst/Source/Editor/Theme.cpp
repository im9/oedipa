#include "Editor/Theme.h"

namespace oedipa {
namespace editor {
namespace theme {

juce::Font dataFont(float pointSize, bool bold)
{
    juce::Font font(juce::FontOptions()
        .withName("JetBrains Mono")
        .withHeight(pointSize)
        .withStyle(bold ? "Bold" : "Regular"));

    // If JetBrains Mono isn't installed, JUCE falls back to a default
    // proportional face — visually wrong for the data-grid feel. Force a
    // monospace fallback by re-querying with Menlo, then the platform
    // monospaced default.
    if (font.getTypefaceName() != "JetBrains Mono") {
        font = juce::Font(juce::FontOptions()
            .withName("Menlo")
            .withHeight(pointSize)
            .withStyle(bold ? "Bold" : "Regular"));
    }
    return font;
}

}  // namespace theme
}  // namespace editor
}  // namespace oedipa
