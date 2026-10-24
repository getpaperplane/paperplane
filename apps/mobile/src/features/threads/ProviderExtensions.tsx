import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { cn } from "../../lib/cn";
import type { useProviderResources } from "../../state/use-provider-resources";

const SCOPE_LABEL = {
  user: "User",
  project: "Project",
  temporary: "Session",
} as const;

type ProviderResources = ReturnType<typeof useProviderResources>;

export { summarizeProviderExtensions } from "./providerExtensionsSummary";

function Stat({ value, label }: { value: string; label: string }) {
  return (
    <View className="min-w-[72px]">
      <Text
        className="text-2xl font-paperplane-medium text-foreground"
        style={{ fontVariant: ["tabular-nums"] }}
      >
        {value}
      </Text>
      <Text className="text-xs text-foreground-muted">{label}</Text>
    </View>
  );
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Text
      accessibilityRole="header"
      className="px-1 pb-2 text-sm font-paperplane-medium text-foreground-muted"
    >
      {children}
    </Text>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return <View className="overflow-hidden rounded-2xl bg-grouped-card">{children}</View>;
}

/** Pi catalog detail body, rendered inside the thread settings stack. */
export function ProviderExtensionsContent(props: ProviderResources) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const warningCount = props.data?.warnings.length ?? 0;
  const compatibilityWarnings = props.data?.compatibilityWarnings ?? [];
  const issueCount = warningCount + compatibilityWarnings.length;
  const modelCount =
    props.data?.modelProviders.reduce((total, provider) => total + provider.modelCount, 0) ?? 0;

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerClassName="gap-6 px-4 pb-12 pt-4"
    >
      <Text className="px-1 text-sm leading-5 text-foreground-muted">
        Global Pi extensions found on the server. Project extensions load in their threads and are
        not listed here. Standard questions work in Paperplane, but Pi terminal components do not.
      </Text>

      <View className="rounded-2xl bg-grouped-card px-4 py-3">
        <View className="flex-row gap-8" accessible accessibilityLabel="Catalog summary">
          <Stat
            value={props.data ? String(props.data.extensions.length) : "–"}
            label="Extensions"
          />
          <Stat value={props.data ? String(modelCount) : "–"} label="Models" />
          <Stat
            value={props.data ? String(issueCount) : "–"}
            label={issueCount === 1 ? "Issue" : "Issues"}
          />
        </View>
      </View>

      {props.isPending && props.data === null ? (
        <Text accessibilityLiveRegion="polite" className="px-1 text-sm text-foreground-muted">
          Loading catalog…
        </Text>
      ) : null}
      {props.error ? (
        <Text accessibilityRole="alert" className="px-1 text-sm text-danger-foreground">
          {props.error}
        </Text>
      ) : null}

      {props.data && warningCount > 0 ? (
        <View>
          <SectionTitle>Needs attention</SectionTitle>
          <Card>
            <View className="gap-1.5 px-4 py-3">
              {props.data.warnings.map((warning) => (
                <Text key={warning} className="text-sm leading-5 text-foreground">
                  • {warning}
                </Text>
              ))}
            </View>
          </Card>
        </View>
      ) : null}

      {props.data && compatibilityWarnings.length > 0 ? (
        <View className="gap-1.5 border-l-2 border-warning-border pl-3">
          <Text
            accessibilityRole="header"
            className="font-paperplane-medium text-sm text-foreground"
          >
            Needs Pi's terminal
          </Text>
          {compatibilityWarnings.map((warning) => (
            <Text key={warning} className="text-sm leading-5 text-foreground-secondary">
              {warning}
            </Text>
          ))}
        </View>
      ) : null}

      {props.data ? (
        <View>
          <SectionTitle>Models</SectionTitle>
          <Card>
            {props.data.modelProviders.length === 0 ? (
              <Text className="px-4 py-3 text-sm text-foreground-muted">
                No extension providers.
              </Text>
            ) : null}
            {props.data.modelProviders.map((provider, index, all) => (
              <View
                key={provider.id}
                className={cn(
                  "gap-0.5 px-4 py-3",
                  index < all.length - 1 && "border-b border-border-subtle",
                )}
              >
                <Text className="text-sm font-paperplane-medium text-foreground">
                  {provider.name}
                </Text>
                <Text className="text-xs text-foreground-muted">
                  {provider.modelCount} {provider.modelCount === 1 ? "model" : "models"} ·{" "}
                  {provider.authenticated ? "Authenticated" : "Sign in needed"}
                </Text>
              </View>
            ))}
          </Card>
        </View>
      ) : null}

      {props.data ? (
        <View>
          <SectionTitle>Extensions</SectionTitle>
          <Card>
            {props.data.extensions.length === 0 ? (
              <Text className="px-4 py-3 text-sm text-foreground-muted">
                Install a Pi extension on the server to see it here.
              </Text>
            ) : null}
            {props.data.extensions.map((extension, index, all) => {
              const isOpen = expanded === extension.path;
              const isDisabled = props.disabledExtensions.includes(extension.path);
              return (
                <View
                  key={extension.path}
                  className={cn(index < all.length - 1 && "border-b border-border-subtle")}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityState={{ expanded: isOpen }}
                    onPress={() => setExpanded(isOpen ? null : extension.path)}
                    className="gap-0.5 px-4 py-3 active:bg-subtle"
                  >
                    <View className="flex-row items-center gap-2">
                      <SymbolView
                        name={isOpen ? "chevron.down" : "chevron.right"}
                        size={12}
                        tintColorClassName="accent-icon-subtle"
                        type="monochrome"
                      />
                      <Text
                        className={cn(
                          "flex-1 text-sm font-paperplane-medium",
                          isDisabled ? "text-foreground-muted" : "text-foreground",
                        )}
                      >
                        {extension.name}
                        {isDisabled ? " (disabled)" : ""}
                      </Text>
                    </View>
                    <Text className="text-xs text-foreground-muted">
                      {SCOPE_LABEL[extension.scope]} · {extension.tools.length}{" "}
                      {extension.tools.length === 1 ? "tool" : "tools"} ·{" "}
                      {extension.commands.length}{" "}
                      {extension.commands.length === 1 ? "command" : "commands"}
                    </Text>
                  </Pressable>
                  {isOpen ? (
                    <View className="gap-1.5 px-4 pb-3">
                      <Text className="text-xs text-foreground-muted" numberOfLines={2}>
                        {extension.path}
                      </Text>
                      <Text className="text-xs text-foreground">
                        Tools: {extension.tools.join(", ") || "None"}
                      </Text>
                      <Text className="text-xs text-foreground">
                        Commands:{" "}
                        {extension.commands.length > 0
                          ? extension.commands.map((command) => `/${command}`).join(", ")
                          : "None"}
                      </Text>
                      <View className="flex-row items-center justify-between gap-2">
                        <Text className="text-xs text-foreground-muted">
                          Loaded in new sessions
                        </Text>
                        <ThemedSwitch
                          accessibilityLabel={`Toggle extension ${extension.name}`}
                          value={!isDisabled}
                          disabled={!props.settingsReady}
                          onValueChange={(loaded) => props.toggleExtension(extension.path, !loaded)}
                        />
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </Card>
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityState={{ busy: props.isPending }}
        disabled={props.isPending}
        onPress={() => void props.refresh()}
        className="items-center rounded-2xl bg-grouped-card px-4 py-3 active:bg-subtle"
      >
        <Text className="text-sm font-paperplane-medium text-foreground">
          {props.error ? "Retry" : "Refresh catalog"}
        </Text>
      </Pressable>
      <Text className="px-1 text-xs leading-5 text-foreground-muted">
        {compatibilityWarnings.length === 0
          ? "Found does not mean every extension feature works in Paperplane. Pi terminal UI stays in Pi. "
          : ""}
        Disabling an extension stops loading it in new Pi sessions; existing sessions reload on
        their next turn.
      </Text>
    </ScrollView>
  );
}
