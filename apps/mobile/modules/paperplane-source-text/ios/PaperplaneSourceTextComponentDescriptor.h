#pragma once

#include "PaperplaneSourceTextShadowNode.h"

#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/core/ConcreteComponentDescriptor.h>

namespace facebook::react {
using PaperplaneSourceTextComponentDescriptor =
    ConcreteComponentDescriptor<PaperplaneSourceTextShadowNode>;

void PaperplaneSourceTextSpec_registerComponentDescriptorsFromCodegen(
    std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
} // namespace facebook::react
