import { useAtomValue } from "@effect/atom-react";
import {
  formatHostMemory,
  formatHostSwap,
  formatPaperplaneCeiling,
  paperplaneCeilingPercent,
} from "@getpaperplane/client-runtime/host-health";
import type { EnvironmentId } from "@getpaperplane/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { Progress } from "../../../components/ui/Progress";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { serverEnvironment } from "../../../state/server";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";

/** Host memory, swap, Paperplane's memory ceiling, and setup findings for one environment. */
export function HostHealthSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(serverEnvironment.hostHealth({ environmentId, input: {} }));
  const report = result._tag === "Success" ? result.value : null;
  if (report === null) return null;
  const swap = formatHostSwap(report);
  const ceiling = formatPaperplaneCeiling(report);
  const ceilingPercent = paperplaneCeilingPercent(report);
  const oomKills = report.paperplaneMemory?.oomKills ?? 0;
  return (
    <SettingsSection title="Host health">
      <View className="gap-1 p-4">
        <Text className="text-base text-foreground">Memory {formatHostMemory(report)}</Text>
        {report.memoryPressure ? (
          <Text className="text-sm text-warning-foreground">
            Low on memory. Paperplane releases idle agents first; new work may be slow or killed.
          </Text>
        ) : null}
        {swap === null ? null : <Text className="text-sm text-foreground-muted">Swap {swap}</Text>}
      </View>
      {ceiling === null ? null : (
        <View className="gap-2 px-4 pb-4">
          <Text className="text-sm text-foreground-muted">Paperplane ceiling {ceiling}</Text>
          {ceilingPercent === null ? null : (
            <Progress value={ceilingPercent / 100} label="Paperplane memory ceiling usage" />
          )}
          {oomKills > 0 ? (
            <Text className="text-sm text-warning-foreground">
              {oomKills} out-of-memory kill{oomKills === 1 ? "" : "s"} since the memory ceiling was
              created.
            </Text>
          ) : null}
        </View>
      )}
      {report.findings.map((finding) => {
        const fix = finding.fix;
        return (
          <View key={finding.id}>
            <View className="flex-row items-start gap-3 px-4 py-3">
              <SymbolView
                name={finding.severity === "warning" ? "exclamationmark.triangle" : "info.circle"}
                size={16}
                tintColorClassName="accent-icon-muted"
              />
              <View className="min-w-0 flex-1 gap-1">
                <Text selectable className="text-sm text-foreground">
                  {finding.message}
                </Text>
                {fix === undefined ? null : (
                  <Text selectable className="font-mono text-sm text-foreground-muted">
                    {fix}
                  </Text>
                )}
              </View>
            </View>
            {fix === undefined ? null : (
              <SettingsActionRow
                icon="doc.on.doc"
                label="Copy fix"
                onPress={() => copyTextWithHaptic(fix, { target: "command" })}
              />
            )}
          </View>
        );
      })}
    </SettingsSection>
  );
}
