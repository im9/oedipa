#include "PointerInteraction.h"

namespace oedipa {
namespace engine {

void PointerInteraction::onPress(int triIdx, double nowMs)
{
    phase_ = Phase::Pressed;
    path_.clear();
    path_.push_back(triIdx);
    pressedAtMs_ = nowMs;
    drifted_ = false;
}

void PointerInteraction::onEnter(int triIdx)
{
    if (phase_ != Phase::Pressed) return;
    if (!path_.empty() && path_.back() == triIdx) return;
    path_.push_back(triIdx);
    drifted_ = true;
}

std::optional<PointerOutcome> PointerInteraction::onTick(double nowMs)
{
    if (phase_ != Phase::Pressed) return std::nullopt;
    if (drifted_) return std::nullopt;
    if ((nowMs - pressedAtMs_) < kLongPressMs) return std::nullopt;
    phase_ = Phase::Anchored;
    return PointerOutcome{PointerOutcome::Kind::Anchor, {path_.front()}};
}

std::optional<PointerOutcome> PointerInteraction::onRelease()
{
    const Phase prev = phase_;
    std::vector<int> path = std::move(path_);
    path_.clear();
    pressedAtMs_ = 0.0;
    const bool drifted = drifted_;
    drifted_ = false;
    phase_ = Phase::Idle;

    if (prev == Phase::Idle) return std::nullopt;
    if (prev == Phase::Anchored) return std::nullopt;
    // Phase::Pressed → Tap or Drag depending on drift
    if (!drifted) {
        return PointerOutcome{PointerOutcome::Kind::Tap, {path.front()}};
    }
    return PointerOutcome{PointerOutcome::Kind::Drag, std::move(path)};
}

void PointerInteraction::cancel()
{
    phase_ = Phase::Idle;
    path_.clear();
    pressedAtMs_ = 0.0;
    drifted_ = false;
}

}  // namespace engine
}  // namespace oedipa
