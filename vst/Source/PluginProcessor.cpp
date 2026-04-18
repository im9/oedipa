#include "PluginProcessor.h"
#include "PluginEditor.h"

OedipaProcessor::OedipaProcessor()
    : AudioProcessor(BusesProperties()) {}

void OedipaProcessor::prepareToPlay(double /*sampleRate*/, int /*samplesPerBlock*/) {}
void OedipaProcessor::releaseResources() {}

void OedipaProcessor::processBlock(juce::AudioBuffer<float>&, juce::MidiBuffer& /*midi*/)
{
    // TODO: Tonnetz MIDI processing
}

juce::AudioProcessorEditor* OedipaProcessor::createEditor()
{
    return new OedipaEditor(*this);
}

void OedipaProcessor::getStateInformation(juce::MemoryBlock& /*destData*/) {}
void OedipaProcessor::setStateInformation(const void* /*data*/, int /*sizeInBytes*/) {}

juce::AudioProcessor* JUCE_CALLTYPE createPluginFilter()
{
    return new OedipaProcessor();
}
