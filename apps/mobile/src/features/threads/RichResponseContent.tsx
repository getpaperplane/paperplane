/* eslint-disable react/no-array-index-key -- Rich payloads are published atomically; fixed block and cell positions preserve disclosure state. */
import { memo, useState } from "react";
import { Alert, Pressable, ScrollView, View } from "react-native";
import type { RichResponse, RichResponseBlock } from "@rove-code/contracts/rich-response";
import type { NativeMarkdownTextStyle } from "@rove-code/mobile-markdown-text/types";
import { AppText as Text } from "../../components/AppText";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";

function RichDetails({
  block,
  textStyle,
}: {
  block: Extract<RichResponseBlock, { type: "details" }>;
  textStyle: NativeMarkdownTextStyle;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <View className="overflow-hidden rounded-lg border border-subtle">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={block.title}
        accessibilityState={{ expanded }}
        onPress={() => setExpanded(!expanded)}
        className="flex-row items-center gap-2 px-3 py-3"
      >
        <Text style={{ color: textStyle.mutedColor }}>{expanded ? "−" : "+"}</Text>
        <Text
          className="flex-1"
          style={{
            color: textStyle.strongColor,
            fontSize: textStyle.fontSize,
            fontFamily: textStyle.boldFontFamily,
          }}
        >
          {block.title}
        </Text>
      </Pressable>
      {expanded ? (
        <Text
          selectable
          className="border-t border-subtle px-3 py-2"
          style={{
            color: textStyle.color,
            fontSize: textStyle.fontSize,
            lineHeight: textStyle.lineHeight,
            fontFamily: textStyle.fontFamily,
          }}
        >
          {block.text}
        </Text>
      ) : null}
    </View>
  );
}

function FollowUpChoice({
  label,
  prompt,
  textStyle,
}: {
  label: string;
  prompt: string;
  textStyle: NativeMarkdownTextStyle;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Copy follow-up: ${label}`}
      className="rounded-lg border border-subtle px-3 py-3"
      onPress={async () => {
        if (await tryCopyTextWithHaptic(prompt)) setCopied(true);
        else Alert.alert("Could not copy follow-up", "Try again.");
      }}
    >
      <Text style={{ color: textStyle.color, fontSize: textStyle.fontSize }}>
        {label}
        {copied ? " · Copied" : ""}
      </Text>
    </Pressable>
  );
}

export const RichResponseContent = memo(function RichResponseContent({
  response,
  textStyle,
}: {
  response: RichResponse;
  textStyle: NativeMarkdownTextStyle;
}) {
  const bodyStyle = {
    color: textStyle.color,
    fontSize: textStyle.fontSize,
    lineHeight: textStyle.lineHeight,
    fontFamily: textStyle.fontFamily,
  };
  const titleStyle = {
    ...bodyStyle,
    color: textStyle.strongColor,
    fontFamily: textStyle.boldFontFamily,
  };
  return (
    <View className="my-3 min-w-0 gap-4">
      {response.blocks.map((block, index) => {
        switch (block.type) {
          case "text":
            return (
              <Text key={index} selectable style={bodyStyle}>
                {block.text}
              </Text>
            );
          case "details":
            return <RichDetails key={index} block={block} textStyle={textStyle} />;
          case "table":
            return (
              <View key={index} className="overflow-hidden rounded-lg border border-subtle">
                <Text selectable className="border-b border-subtle px-3 py-2" style={titleStyle}>
                  {block.title}
                </Text>
                <ScrollView horizontal accessibilityLabel={block.title}>
                  <View>
                    <View className="flex-row bg-subtle">
                      {block.columns.map((column, columnIndex) => (
                        <Text
                          key={columnIndex}
                          selectable
                          className="w-40 px-3 py-2"
                          style={titleStyle}
                        >
                          {column}
                        </Text>
                      ))}
                    </View>
                    {block.rows.map((row, rowIndex) => (
                      <View key={rowIndex} className="flex-row border-t border-subtle">
                        {row.map((cell, columnIndex) => (
                          <Text
                            key={columnIndex}
                            selectable
                            className="w-40 px-3 py-2"
                            style={bodyStyle}
                          >
                            {cell}
                          </Text>
                        ))}
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </View>
            );
          case "choices":
            return (
              <View key={index} className="gap-2">
                <Text style={titleStyle}>{block.title}</Text>
                <Text style={{ ...bodyStyle, color: textStyle.mutedColor }}>
                  Copy a follow-up to edit and send yourself.
                </Text>
                {block.options.map((option, optionIndex) => (
                  <FollowUpChoice key={optionIndex} {...option} textStyle={textStyle} />
                ))}
              </View>
            );
        }
      })}
    </View>
  );
});
