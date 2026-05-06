cmake_minimum_required(VERSION 3.15)
project(Oedipa VERSION 0.1.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_subdirectory(JUCE)

# --- Test dependencies (ADR 008 §"Test infrastructure") -----------------------
# Catch2 v3 + nlohmann/json v3 fetched at configure time. Both are header-only-
# friendly via FetchContent and avoid an out-of-tree submodule. nlohmann/json's
# JSON_BuildTests is forced off so we don't compile its own test suite.
include(FetchContent)

FetchContent_Declare(
    Catch2
    GIT_REPOSITORY https://github.com/catchorg/Catch2.git
    GIT_TAG v3.5.4
)

set(JSON_BuildTests OFF CACHE INTERNAL "")
FetchContent_Declare(
    nlohmann_json
    GIT_REPOSITORY https://github.com/nlohmann/json.git
    GIT_TAG v3.11.3
)

FetchContent_MakeAvailable(Catch2 nlohmann_json)

# --- Engine static library (ADR 008 §"Shared logic layer") --------------------
# Pure C++17. NO juce_* link or include — this is the iOS-reuse boundary.
# Both the plugin (Oedipa) and the test binary (oedipa_tests) link this.
add_library(oedipa_engine STATIC
    Source/Engine/Tonnetz.cpp
    Source/Engine/Tonnetz.h
    Source/Engine/State.h
    Source/Engine/Walker.cpp
    Source/Engine/Walker.h
    Source/Engine/Lattice.cpp
    Source/Engine/Lattice.h
    Source/Engine/PointerInteraction.cpp
    Source/Engine/PointerInteraction.h
    Source/Engine/SequenceDrawer.cpp
    Source/Engine/SequenceDrawer.h
    Source/Engine/SlotBank.cpp
    Source/Engine/SlotBank.h
    Source/Engine/Presets.h
)
target_include_directories(oedipa_engine PUBLIC Source)
target_compile_features(oedipa_engine PUBLIC cxx_std_17)

# --- Plugin -------------------------------------------------------------------
juce_add_plugin(Oedipa
    COMPANY_NAME "im9"
    BUNDLE_ID "com.im9.oedipa"
    IS_SYNTH FALSE
    NEEDS_MIDI_INPUT TRUE
    NEEDS_MIDI_OUTPUT TRUE
    IS_MIDI_EFFECT TRUE
    PLUGIN_MANUFACTURER_CODE "Im9x"
    PLUGIN_CODE "Oedp"
    FORMATS VST3 AU Standalone
    PRODUCT_NAME "Oedipa"
    # On every build, JUCE copies the VST3/AU bundles to the user's
    # Audio Plug-Ins folders (Standalone is skipped). Removes the
    # per-build manual copy/symlink step for the Logic / Cubase dev loop.
    COPY_PLUGIN_AFTER_BUILD TRUE
)

target_sources(Oedipa PRIVATE
    Source/Plugin/PluginProcessor.cpp
    Source/Plugin/PluginProcessor.h
    Source/Plugin/Parameters.cpp
    Source/Plugin/Parameters.h
    Source/Editor/PluginEditor.cpp
    Source/Editor/PluginEditor.h
    Source/Editor/LatticeView.cpp
    Source/Editor/LatticeView.h
    Source/Editor/Theme.cpp
    Source/Editor/Theme.h
    Source/Editor/RightRailView.cpp
    Source/Editor/RightRailView.h
    Source/Editor/SlotBarView.cpp
    Source/Editor/SlotBarView.h
    Source/Editor/SequenceRowView.cpp
    Source/Editor/SequenceRowView.h
    Source/Editor/SequenceDrawerView.cpp
    Source/Editor/SequenceDrawerView.h
    Source/Editor/VoicingView.cpp
    Source/Editor/VoicingView.h
    Source/Editor/AnchorsView.cpp
    Source/Editor/AnchorsView.h
    Source/Editor/OutputView.cpp
    Source/Editor/OutputView.h
    Source/Editor/PresetView.cpp
    Source/Editor/PresetView.h
)
target_include_directories(Oedipa PRIVATE Source)

target_link_libraries(Oedipa PRIVATE
    oedipa_engine
    juce::juce_audio_basics
    juce::juce_audio_processors
    juce::juce_audio_utils
    juce::juce_gui_basics
    juce::juce_gui_extra
    juce::juce_audio_plugin_client
)

target_compile_definitions(Oedipa PRIVATE
    JUCE_IGNORE_VST3_MISMATCHED_PARAMETER_ID_WARNING=1
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
)

# --- Plugin core static library (state I/O surface used by tests) -------------
# AudioProcessor + APVTS + state serialization, separated from the JUCE plugin
# bundle so the test binary can link it without pulling in juce_audio_plugin_client
# (which provides the AU/VST3 wrappers and is plugin-only).
add_library(oedipa_plugin_core STATIC
    Source/Plugin/PluginProcessor.cpp
    Source/Plugin/Parameters.cpp
    Source/Editor/PluginEditor.cpp
    Source/Editor/LatticeView.cpp
    Source/Editor/Theme.cpp
    Source/Editor/RightRailView.cpp
    Source/Editor/SlotBarView.cpp
    Source/Editor/SequenceRowView.cpp
    Source/Editor/SequenceDrawerView.cpp
    Source/Editor/VoicingView.cpp
    Source/Editor/AnchorsView.cpp
    Source/Editor/OutputView.cpp
    Source/Editor/PresetView.cpp
)
target_include_directories(oedipa_plugin_core PUBLIC Source)
target_link_libraries(oedipa_plugin_core PUBLIC
    oedipa_engine
    juce::juce_audio_basics
    juce::juce_audio_processors
    juce::juce_audio_utils
    juce::juce_gui_basics
    juce::juce_gui_extra
)
target_compile_definitions(oedipa_plugin_core PUBLIC
    JUCE_USE_CURL=0
    JUCE_WEB_BROWSER=0
    JUCE_STANDALONE_APPLICATION=0
)

# --- Tests --------------------------------------------------------------------
# Custom main (tests/main.cpp) owns JUCE init/shutdown so it stays scoped
# inside main(). Catch2 (no `WithMain`) exposes the session API only.
add_executable(oedipa_tests
    tests/main.cpp
    tests/test_Tonnetz.cpp
    tests/test_Plugin.cpp
    tests/test_Walker.cpp
    tests/test_Lattice.cpp
    tests/test_PointerInteraction.cpp
    tests/test_SequenceDrawer.cpp
    tests/test_SlotBank.cpp
    tests/test_PluginSlotBank.cpp
    tests/test_Editor.cpp
)
target_link_libraries(oedipa_tests PRIVATE
    oedipa_engine
    oedipa_plugin_core
    Catch2::Catch2
    nlohmann_json::nlohmann_json
)
target_compile_features(oedipa_tests PRIVATE cxx_std_17)
target_compile_definitions(oedipa_tests PRIVATE
    OEDIPA_TEST_VECTORS_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../docs/ai/tonnetz-test-vectors.json"
)
