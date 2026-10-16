#import "RoveSourceTextRun.h"
#import <React/RCTFabricComponentsPlugins.h>
#import "RoveSourceTextRunComponentDescriptor.h"
#import <react/renderer/components/RoveSourceTextSpec/Props.h>
#import <react/renderer/components/RoveSourceTextSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface RoveSourceTextRun () <RCTT3SourceTextRunViewProtocol>

@end

@implementation RoveSourceTextRun {
  NSString *_text;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<
      RoveSourceTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const RoveSourceTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<RoveSourceTextRunProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<RoveSourceTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> RoveSourceTextRunCls(void) {
  return RoveSourceTextRun.class;
}

@end
