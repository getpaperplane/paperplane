#pragma once

#include "PaperplaneSourceTextRunShadowNode.h"

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {
using PaperplaneSourceTextRunComponentDescriptor =
    ConcreteComponentDescriptor<PaperplaneSourceTextRunShadowNode>;

void PaperplaneSourceTextRunSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
} // namespace facebook::react
