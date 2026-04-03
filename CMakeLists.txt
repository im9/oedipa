cmake_minimum_required(VERSION 3.15)
project(Oedipa VERSION 0.1.0)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

add_subdirectory(JUCE)

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

# Tests
add_executable(oedipa_tests
    tests/test_Tonnetz.cpp
)
target_include_directories(oedipa_tests PRIVATE Source)
target_link_libraries(oedipa_tests PRIVATE Catch2::Catch2WithMain)
target_compile_features(oedipa_tests PRIVATE cxx_std_17)
