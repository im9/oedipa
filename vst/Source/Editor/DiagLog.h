// Diagnostic logging gate for the editor. Off by default — flip the
// #define below to 1, rebuild, reproduce the bug, then send the log
// file. Always set back to 0 before merging.
//
// Output path: ~/Library/Logs/Oedipa-diag.log
//   • Logic Pro's sandbox permits writes here for AU plugins.
//   • Inspect from Terminal:  tail -f ~/Library/Logs/Oedipa-diag.log

#pragma once

#define OEDIPA_DIAG 1

#if OEDIPA_DIAG
#include <juce_core/juce_core.h>

namespace oedipa { namespace editor {

inline juce::FileLogger& diagLogger() {
    static auto* logger = []() {
        auto file = juce::File::getSpecialLocation(juce::File::userHomeDirectory)
                        .getChildFile("Library/Logs/Oedipa-diag.log");
        file.getParentDirectory().createDirectory();
        if (file.exists()) file.deleteFile();
        return new juce::FileLogger(file,
            "Oedipa diag — paint/resize trace. timestamps in ms.\n");
    }();
    return *logger;
}

}}  // namespace oedipa::editor

#define OEDIPA_DIAG_LOG(msg) ::oedipa::editor::diagLogger().logMessage(msg)
#else
#define OEDIPA_DIAG_LOG(msg) ((void)0)
#endif
