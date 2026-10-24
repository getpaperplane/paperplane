#import "PaperplaneSourceTextRun.h"
#import <React/RCTFabricComponentsPlugins.h>
#import "PaperplaneSourceTextRunComponentDescriptor.h"
#import <react/renderer/components/PaperplaneSourceTextSpec/Props.h>
#import <react/renderer/components/PaperplaneSourceTextSpec/RCTComponentViewHelpers.h>

using namespace facebook::react;

@interface PaperplaneSourceTextRun () <RCTPaperplaneSourceTextRunViewProtocol>

@end

@implementation PaperplaneSourceTextRun {
  NSString *_text;
}

+ (ComponentDescriptorProvider)componentDescriptorProvider {
  return concreteComponentDescriptorProvider<
      PaperplaneSourceTextRunComponentDescriptor>();
}

- (instancetype)initWithFrame:(CGRect)frame {
  if (self = [super initWithFrame:frame]) {
    static const auto defaultProps =
        std::make_shared<const PaperplaneSourceTextRunProps>();
    _props = defaultProps;
  }
  return self;
}

- (void)updateProps:(Props::Shared const &)props
           oldProps:(Props::Shared const &)oldProps {
  const auto &oldViewProps =
      *std::static_pointer_cast<PaperplaneSourceTextRunProps const>(_props);
  const auto &newViewProps =
      *std::static_pointer_cast<PaperplaneSourceTextRunProps const>(props);

  if (newViewProps.text != oldViewProps.text) {
    NSString *text = [NSString stringWithUTF8String:newViewProps.text.c_str()];
    _text = text;
  }

  [super updateProps:props oldProps:oldProps];
}

+ (BOOL)shouldBeRecycled {
  return NO;
}

Class<RCTComponentViewProtocol> PaperplaneSourceTextRunCls(void) {
  return PaperplaneSourceTextRun.class;
}

@end
