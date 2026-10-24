#import <React/RCTUIManager.h>
#import <React/RCTViewManager.h>

@interface PaperplaneSourceTextManager : RCTViewManager
@end

@implementation PaperplaneSourceTextManager

RCT_EXPORT_MODULE(PaperplaneSourceText)

- (UIView *)view {
  return [[UIView alloc] init];
}

@end

@interface PaperplaneSourceTextRunManager : RCTViewManager
@end

@implementation PaperplaneSourceTextRunManager

RCT_EXPORT_MODULE(PaperplaneSourceTextRun)

- (UIView *)view {
  return nil;
}

@end
