#include "RoveSourceTextShadowNode.h"
#include "RoveSourceTextRunShadowNode.h"
#include <react/renderer/components/view/ViewShadowNode.h>
#import <react/renderer/textlayoutmanager/RCTAttributedTextUtils.h>

#include <algorithm>
#include <cmath>

namespace facebook::react {

RoveSourceTextShadowNode::RoveSourceTextShadowNode(
    const ShadowNode &sourceShadowNode, const ShadowNodeFragment &fragment)
    : ConcreteViewShadowNode(sourceShadowNode, fragment){};

Size RoveSourceTextShadowNode::measureContent(
    const LayoutContext &layoutContext,
    const LayoutConstraints &layoutConstraints) const {
  const auto &baseProps = getConcreteProps();

  auto baseTextAttributes = TextAttributes::defaultTextAttributes();
  baseTextAttributes.backgroundColor = baseProps.backgroundColor;
  baseTextAttributes.allowFontScaling = baseProps.allowFontScaling;

  Float fontSizeMultiplier = 1.0;
  if (baseTextAttributes.allowFontScaling) {
    fontSizeMultiplier = layoutContext.fontSizeMultiplier;
  }

  auto baseAttributedString = AttributedString{};
  const auto &children = getChildren();
  for (size_t i = 0; i < children.size(); i++) {
    const auto child = children[i].get();
    if (auto textViewChild =
            dynamic_cast<const RoveSourceTextRunShadowNode *>(child)) {
      auto &props = textViewChild->getConcreteProps();
      auto fragment = AttributedString::Fragment{};
      auto textAttributes = TextAttributes::defaultTextAttributes();

      textAttributes.allowFontScaling = baseProps.allowFontScaling;
      textAttributes.backgroundColor = props.backgroundColor;
      textAttributes.fontSize = props.fontSize * fontSizeMultiplier;
      textAttributes.lineHeight = props.lineHeight * fontSizeMultiplier;
      textAttributes.foregroundColor = props.color;
      textAttributes.textShadowColor = props.shadowColor;
      textAttributes.textShadowOffset = props.shadowOffset;
      textAttributes.textShadowRadius = props.shadowRadius;
      textAttributes.letterSpacing = props.letterSpacing;
      textAttributes.textDecorationColor = props.textDecorationColor;
      textAttributes.fontFamily = props.fontFamily;

      if (props.fontStyle == RoveSourceTextRunFontStyle::Italic) {
        textAttributes.fontStyle = FontStyle::Italic;
      } else {
        textAttributes.fontStyle = FontStyle::Normal;
      }

      if (props.fontWeight == RoveSourceTextRunFontWeight::Bold) {
        textAttributes.fontWeight = FontWeight::Bold;
      } else if (props.fontWeight == RoveSourceTextRunFontWeight::UltraLight) {
        textAttributes.fontWeight = FontWeight::UltraLight;
      } else if (props.fontWeight == RoveSourceTextRunFontWeight::Light) {
        textAttributes.fontWeight = FontWeight::Light;
      } else if (props.fontWeight == RoveSourceTextRunFontWeight::Medium) {
        textAttributes.fontWeight = FontWeight::Medium;
      } else if (props.fontWeight == RoveSourceTextRunFontWeight::Semibold) {
        textAttributes.fontWeight = FontWeight::Semibold;
      } else if (props.fontWeight == RoveSourceTextRunFontWeight::Heavy) {
        textAttributes.fontWeight = FontWeight::Heavy;
      } else {
        textAttributes.fontWeight = FontWeight::Regular;
      }

      if (props.textDecorationLine ==
          RoveSourceTextRunTextDecorationLine::LineThrough) {
        textAttributes.textDecorationLineType =
            TextDecorationLineType::Strikethrough;
      } else if (props.textDecorationLine ==
                 RoveSourceTextRunTextDecorationLine::Underline) {
        textAttributes.textDecorationLineType =
            TextDecorationLineType::Underline;
      } else {
        textAttributes.textDecorationLineType = TextDecorationLineType::None;
      }

      if (props.textDecorationStyle ==
          RoveSourceTextRunTextDecorationStyle::Solid) {
        textAttributes.textDecorationStyle = TextDecorationStyle::Solid;
      } else if (props.textDecorationStyle ==
                 RoveSourceTextRunTextDecorationStyle::Dotted) {
        textAttributes.textDecorationStyle = TextDecorationStyle::Dotted;
      } else if (props.textDecorationStyle ==
                 RoveSourceTextRunTextDecorationStyle::Dashed) {
        textAttributes.textDecorationStyle = TextDecorationStyle::Dashed;
      } else if (props.textDecorationStyle ==
                 RoveSourceTextRunTextDecorationStyle::Double) {
        textAttributes.textDecorationStyle = TextDecorationStyle::Double;
      }

      if (props.textAlign == RoveSourceTextRunTextAlign::Left) {
        textAttributes.alignment = TextAlignment::Left;
      } else if (props.textAlign == RoveSourceTextRunTextAlign::Right) {
        textAttributes.alignment = TextAlignment::Right;
      } else if (props.textAlign == RoveSourceTextRunTextAlign::Center) {
        textAttributes.alignment = TextAlignment::Center;
      } else if (props.textAlign == RoveSourceTextRunTextAlign::Justify) {
        textAttributes.alignment = TextAlignment::Justified;
      } else if (props.textAlign == RoveSourceTextRunTextAlign::Auto) {
        textAttributes.alignment = TextAlignment::Natural;
      }

      textAttributes.backgroundColor = props.backgroundColor;

      fragment.string = props.text;
      fragment.textAttributes = textAttributes;

      baseAttributedString.appendFragment(std::move(fragment));
    }
  }

  _attributedString = baseAttributedString;

  NSMutableAttributedString *convertedAttributedString =
      [RCTNSAttributedStringFromAttributedString(baseAttributedString)
          mutableCopy];
  // Match React Native's baseline offset in both measurement and rendering.
  RCTApplyBaselineOffset(convertedAttributedString);

  const CGFloat maximumWidth =
      std::isfinite(layoutConstraints.maximumSize.width)
          ? layoutConstraints.maximumSize.width
          : CGFLOAT_MAX;
  NSTextStorage *textStorage = [[NSTextStorage alloc]
      initWithAttributedString:convertedAttributedString];
  NSLayoutManager *layoutManager = [[NSLayoutManager alloc] init];
  layoutManager.usesFontLeading = NO;
  NSTextContainer *textContainer = [[NSTextContainer alloc]
      initWithSize:CGSizeMake(maximumWidth, CGFLOAT_MAX)];
  textContainer.lineFragmentPadding = 0;
  textContainer.maximumNumberOfLines = baseProps.numberOfLines;
  if (baseProps.ellipsizeMode == RoveSourceTextEllipsizeMode::Head) {
    textContainer.lineBreakMode = NSLineBreakByTruncatingHead;
  } else if (baseProps.ellipsizeMode == RoveSourceTextEllipsizeMode::Middle) {
    textContainer.lineBreakMode = NSLineBreakByTruncatingMiddle;
  } else if (baseProps.ellipsizeMode == RoveSourceTextEllipsizeMode::Tail) {
    textContainer.lineBreakMode = NSLineBreakByTruncatingTail;
  } else {
    textContainer.lineBreakMode = NSLineBreakByClipping;
  }
  [layoutManager addTextContainer:textContainer];
  [textStorage addLayoutManager:layoutManager];
  [layoutManager ensureLayoutForTextContainer:textContainer];
  const CGRect usedRect =
      [layoutManager usedRectForTextContainer:textContainer];

  return {
      std::clamp(static_cast<Float>(std::ceil(usedRect.size.width)),
                 layoutConstraints.minimumSize.width,
                 layoutConstraints.maximumSize.width),
      std::clamp(static_cast<Float>(std::ceil(usedRect.size.height)),
                 layoutConstraints.minimumSize.height,
                 layoutConstraints.maximumSize.height),
  };
}

void RoveSourceTextShadowNode::layout(LayoutContext layoutContext) {
  ensureUnsealed();
  setStateData(RoveSourceTextStateReal{
      _attributedString,
  });
}
} // namespace facebook::react
