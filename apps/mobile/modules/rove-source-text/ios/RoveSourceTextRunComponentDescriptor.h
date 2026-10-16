#pragma once

#include "RoveSourceTextRunShadowNode.h"

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {
using RoveSourceTextRunComponentDescriptor =
    ConcreteComponentDescriptor<RoveSourceTextRunShadowNode>;

void RoveSourceTextRunSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
} // namespace facebook::react
