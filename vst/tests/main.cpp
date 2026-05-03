// Test entry point. Owns JUCE init/shutdown explicitly so the lifecycle is
// scoped INSIDE main() rather than ridding on static destructors. The
// auto-static path (a `juce::ScopedJuceInitialiser_GUI` at namespace scope)
// fires its destructor AFTER Catch2's statics have been torn down, which
// turns DeletedAtShutdown::deleteAll() into a libmalloc abort. Initializing
// here at main()-entry and shutting down before main()-return keeps both
// systems alive at the same time.

#include <catch2/catch_session.hpp>

#include <juce_events/juce_events.h>
#include <juce_gui_basics/juce_gui_basics.h>

int main(int argc, char* argv[])
{
    juce::initialiseJuce_GUI();
    const int result = Catch::Session().run(argc, argv);
    juce::shutdownJuce_GUI();
    return result;
}
