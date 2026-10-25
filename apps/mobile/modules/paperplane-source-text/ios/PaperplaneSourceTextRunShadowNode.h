#pragma once

#include <react/renderer/components/PaperplaneSourceTextSpec/EventEmitters.h>
#include <react/renderer/components/PaperplaneSourceTextSpec/Props.h>
#include <react/renderer/components/PaperplaneSourceTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char PaperplaneSourceTextRunComponentName[];

using PaperplaneSourceTextRunShadowNode =
    ConcreteViewShadowNode<PaperplaneSourceTextRunComponentName, PaperplaneSourceTextRunProps,
                           PaperplaneSourceTextRunEventEmitter, PaperplaneSourceTextRunState>;
} // namespace facebook::react
