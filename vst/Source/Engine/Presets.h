// Factory presets, ported 1:1 from m4l/host/presets.ts.
//
// Storage shape is `engine::Slot` directly — no string format. The m4l
// version went through `parseSlot` because Max attribute payloads are
// strings; here the editor calls `applySlot` with the struct.
//
// JUCE-free; lives under Engine/ alongside Slot definition.

#pragma once

#include "Engine/State.h"

#include <string_view>

namespace oedipa {
namespace engine {

struct FactoryPreset {
    std::string_view name;
    Slot slot;
};

// `length` is fixed at 4 cells for shipped presets (matches m4l). Cells
// 4..7 default to Hold so the slot still has 8 ops total.
const FactoryPreset kFactoryPresets[] = {
    // Steady — pure P transforms (major↔minor on the same root).
    {"Steady", {{Op::P, Op::P, Op::P, Op::P,
                 Op::Hold, Op::Hold, Op::Hold, Op::Hold},
                /*startRootPc*/ 0, Quality::Major, /*jitter*/ 0.0f, /*seed*/ 0u}},
    // Drift — L motion with sparse holds, A minor.
    {"Drift", {{Op::L, Op::Hold, Op::L, Op::Hold,
                Op::Hold, Op::Hold, Op::Hold, Op::Hold},
               9, Quality::Minor, 0.0f, 0u}},
    // Cycle — relative-key motion, E minor.
    {"Cycle", {{Op::R, Op::R, Op::R, Op::R,
                Op::Hold, Op::Hold, Op::Hold, Op::Hold},
               4, Quality::Minor, 0.0f, 0u}},
    // Mixed — canonical PLR_ in C major (matches default-device program).
    {"Mixed", {{Op::P, Op::L, Op::R, Op::Hold,
                Op::Hold, Op::Hold, Op::Hold, Op::Hold},
               0, Quality::Major, 0.0f, 0u}},
    // Pulse — motion-rest pulse, G major.
    {"Pulse", {{Op::P, Op::Rest, Op::L, Op::Rest,
                Op::Hold, Op::Hold, Op::Hold, Op::Hold},
               7, Quality::Major, 0.0f, 0u}},
    // Jitter Web — all-holds + jitter 0.6 (substitutes ~60% of cells with
    // motion). Seed pinned so the preset sounds the same every load.
    {"Jitter Web", {{Op::Hold, Op::Hold, Op::Hold, Op::Hold,
                     Op::Hold, Op::Hold, Op::Hold, Op::Hold},
                    0, Quality::Major, 0.6f, 42u}},
};

constexpr int kFactoryPresetCount = (int) (sizeof(kFactoryPresets) / sizeof(kFactoryPresets[0]));

}  // namespace engine
}  // namespace oedipa
