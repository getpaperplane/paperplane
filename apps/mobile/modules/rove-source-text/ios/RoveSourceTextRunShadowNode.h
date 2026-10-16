#pragma once

#include <react/renderer/components/RoveSourceTextSpec/EventEmitters.h>
#include <react/renderer/components/RoveSourceTextSpec/Props.h>
#include <react/renderer/components/RoveSourceTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char RoveSourceTextRunComponentName[];

using RoveSourceTextRunShadowNode =
    ConcreteViewShadowNode<RoveSourceTextRunComponentName, RoveSourceTextRunProps,
                           RoveSourceTextRunEventEmitter, RoveSourceTextRunState>;
} // namespace facebook::react
