#import <React/RCTUIManager.h>
#import <React/RCTViewManager.h>

@interface RoveSourceTextManager : RCTViewManager
@end

@implementation RoveSourceTextManager

RCT_EXPORT_MODULE(RoveSourceText)

- (UIView *)view {
  return [[UIView alloc] init];
}

@end

@interface RoveSourceTextRunManager : RCTViewManager
@end

@implementation RoveSourceTextRunManager

RCT_EXPORT_MODULE(RoveSourceTextRun)

- (UIView *)view {
  return nil;
}

@end
