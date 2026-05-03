// Cross-target conformance test for the Tonnetz engine. Iterates the cases in
// docs/ai/tonnetz-test-vectors.json (single source of truth across m4l/vst/app
// per ADR 001 §"Test vectors"). New semantic cases go in the JSON, not here.
//
// Phase 1 scope (ADR 008): identify_triad, apply_transform, roundtrip, voicing,
// seventh. Walk / cells / PRNG / rhythm / arp groups are exercised once Phases
// 3-5 land the supporting engine surface.

#include <catch2/catch_test_macros.hpp>
#include <nlohmann/json.hpp>

#include "Engine/Tonnetz.h"

#include <algorithm>
#include <fstream>
#include <set>
#include <stdexcept>
#include <string>
#include <vector>

#ifndef OEDIPA_TEST_VECTORS_PATH
#error "OEDIPA_TEST_VECTORS_PATH must be defined by the build (see vst/CMakeLists.txt)"
#endif

using json = nlohmann::json;
using namespace oedipa::engine;

namespace {

const json& vectors()
{
    static const json data = []() {
        std::ifstream stream{OEDIPA_TEST_VECTORS_PATH};
        if (!stream) {
            throw std::runtime_error(std::string{"cannot open "} + OEDIPA_TEST_VECTORS_PATH);
        }
        return json::parse(stream);
    }();
    return data;
}

Triad triadFromJson(const json& arr)
{
    return {arr.at(0).get<int>(), arr.at(1).get<int>(), arr.at(2).get<int>()};
}

std::vector<int> pcsOf(const std::vector<MidiNote>& notes)
{
    std::vector<int> pcs;
    pcs.reserve(notes.size());
    for (auto n : notes) pcs.push_back(((n % 12) + 12) % 12);
    std::sort(pcs.begin(), pcs.end());
    return pcs;
}

std::vector<int> pcsOf(const Triad& t)
{
    return pcsOf(std::vector<MidiNote>{t[0], t[1], t[2]});
}

std::vector<int> intsFromJson(const json& arr)
{
    std::vector<int> out;
    out.reserve(arr.size());
    for (const auto& v : arr) out.push_back(v.get<int>());
    std::sort(out.begin(), out.end());
    return out;
}

Quality qualityFromString(const std::string& s)
{
    if (s == "major") return Quality::Major;
    if (s == "minor") return Quality::Minor;
    throw std::invalid_argument("unknown quality: " + s);
}

Transform transformFromString(const std::string& s)
{
    if (s == "P") return Transform::P;
    if (s == "L") return Transform::L;
    if (s == "R") return Transform::R;
    throw std::invalid_argument("unknown transform: " + s);
}

Voicing voicingFromString(const std::string& s)
{
    if (s == "close")  return Voicing::Close;
    if (s == "spread") return Voicing::Spread;
    if (s == "drop2")  return Voicing::Drop2;
    throw std::invalid_argument("unknown voicing: " + s);
}

}  // namespace

TEST_CASE("identify_triad — root pc + quality from any inversion", "[tonnetz][identify]")
{
    for (const auto& c : vectors().at("identify_triad")) {
        DYNAMIC_SECTION(c.at("name").get<std::string>()) {
            const auto t = triadFromJson(c.at("input"));
            const auto id = identifyTriad(t);
            CHECK(id.rootPc == c.at("expected").at("root_pc").get<int>());
            CHECK(id.quality == qualityFromString(c.at("expected").at("quality").get<std::string>()));
        }
    }
}

TEST_CASE("apply_transform — PC-set equality after one P/L/R", "[tonnetz][transform]")
{
    for (const auto& c : vectors().at("apply_transform")) {
        DYNAMIC_SECTION(c.at("name").get<std::string>()) {
            const auto t = triadFromJson(c.at("input"));
            const auto op = transformFromString(c.at("op").get<std::string>());
            const auto out = applyTransform(t, op);
            CHECK(pcsOf(out) == intsFromJson(c.at("expected_pcs")));
        }
    }
}

TEST_CASE("roundtrip — applying op twice returns original PC set", "[tonnetz][transform]")
{
    for (const auto& c : vectors().at("roundtrip")) {
        DYNAMIC_SECTION(c.at("name").get<std::string>()) {
            auto chord = triadFromJson(c.at("input"));
            for (const auto& opStr : c.at("ops")) {
                chord = applyTransform(chord, transformFromString(opStr.get<std::string>()));
            }
            CHECK(pcsOf(chord) == intsFromJson(c.at("expected_pcs")));
        }
    }
}

TEST_CASE("voicing — exact MIDI layout for close/spread/drop2", "[tonnetz][voicing]")
{
    for (const auto& c : vectors().at("voicing")) {
        DYNAMIC_SECTION(c.at("name").get<std::string>()) {
            const auto t = triadFromJson(c.at("input"));
            const auto mode = voicingFromString(c.at("mode").get<std::string>());
            const auto out = applyVoicing(t, mode);
            std::vector<int> expected;
            for (const auto& v : c.at("expected")) expected.push_back(v.get<int>());
            CHECK(out == expected);
        }
    }
}

TEST_CASE("seventh — maj7 (+11) / min7 (+10) appended above root", "[tonnetz][seventh]")
{
    for (const auto& c : vectors().at("seventh")) {
        DYNAMIC_SECTION(c.at("name").get<std::string>()) {
            std::vector<MidiNote> voiced;
            for (const auto& v : c.at("voiced")) voiced.push_back(v.get<int>());
            const auto triad = triadFromJson(c.at("triad"));
            const auto id = identifyTriad(triad);
            const auto out = addSeventh(voiced, id.quality);
            std::vector<int> expected;
            for (const auto& v : c.at("expected")) expected.push_back(v.get<int>());
            CHECK(out == expected);
        }
    }
}
