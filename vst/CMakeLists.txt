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
)

target_sources(Oedipa PRIVATE
    Source/PluginProcessor.cpp
    Source/PluginProcessor.h
    Source/PluginEditor.cpp
    Source/PluginEditor.h
)

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
)

juce_generate_juce_header(Oedipa)

# --- Tests --------------------------------------------------------------------
add_executable(oedipa_tests
    tests/test_Tonnetz.cpp
)
target_link_libraries(oedipa_tests PRIVATE
    oedipa_engine
    Catch2::Catch2WithMain
    nlohmann_json::nlohmann_json
)
target_compile_features(oedipa_tests PRIVATE cxx_std_17)
target_compile_definitions(oedipa_tests PRIVATE
    OEDIPA_TEST_VECTORS_PATH="${CMAKE_CURRENT_SOURCE_DIR}/../docs/ai/tonnetz-test-vectors.json"
)
