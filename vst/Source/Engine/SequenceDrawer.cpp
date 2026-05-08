#include "Engine/SequenceDrawer.h"

namespace oedipa {
namespace engine {

void SequenceDrawer::toggle(int cellIdx)
{
    if (selected_ == cellIdx) {
        selected_ = -1;
    } else {
        selected_ = cellIdx;
    }
}

void SequenceDrawer::onSequenceLengthChanged(int newLength)
{
    if (selected_ >= newLength) {
        selected_ = -1;
    }
}

}  // namespace engine
}  // namespace oedipa
