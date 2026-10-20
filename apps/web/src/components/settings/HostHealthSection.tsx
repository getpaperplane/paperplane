import { useAtomValue } from "@effect/atom-react";
import {
  formatHostMemory,
  formatHostSwap,
  formatRoveCeiling,
  roveCeilingPercent,
} from "@rove-code/client-runtime/host-health";
import type { EnvironmentId } from "@rove-code/contracts";
import { AlertTriangleIcon, InfoIcon } from "lucide-react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import { Progress } from "../ui/progress";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Host memory, swap, Rove's memory ceiling, and setup findings for one environment. */
export function HostHealthSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const result = useAtomValue(serverEnvironment.hostHealth({ environmentId, input: {} }));
  const { copyToClipboard } = useCopyToClipboard({ target: "command" });
  const report = result._tag === "Success" ? result.value : null;
  if (report === null) return null;
  const swap = formatHostSwap(report);
  const ceiling = formatRoveCeiling(report);
  const ceilingPercent = roveCeilingPercent(report);
  return (
    <SettingsSection id="diagnostics-host-health" title="Host Health">
      <SettingsGroup>
        <SettingsRow
          title="Memory"
          description={
            report.memoryPressure
              ? "Low on memory. Rove releases idle agents first; new work may be slow or killed."
              : undefined
          }
          status={formatHostMemory(report)}
        />
        {swap === null ? null : <SettingsRow title="Swap" status={swap} />}
        {ceiling === null || report.roveMemory === null ? null : (
          <SettingsRow
            title="Rove memory ceiling"
            description={
              report.roveMemory.oomKills > 0
                ? `${report.roveMemory.oomKills} out-of-memory kill${report.roveMemory.oomKills === 1 ? "" : "s"} since the memory ceiling was created.`
                : "Shared by every agent and terminal Rove starts."
            }
            status={ceiling}
          >
            {ceilingPercent === null ? null : (
              <div className="pt-1 pb-2">
                <Progress value={ceilingPercent} label="Rove memory ceiling usage" />
              </div>
            )}
          </SettingsRow>
        )}
        {report.findings.map((finding) => {
          const fix = finding.fix;
          return (
            <SettingsRow
              key={finding.id}
              title={
                <span className="flex items-center gap-1.5">
                  {finding.severity === "warning" ? (
                    <AlertTriangleIcon aria-label="Warning" className="size-3.5 text-warning" />
                  ) : (
                    <InfoIcon aria-label="Info" className="size-3.5 text-muted-foreground" />
                  )}
                  {finding.message}
                </span>
              }
              description={
                fix === undefined ? undefined : (
                  <code className="mt-1 block select-text break-all">{fix}</code>
                )
              }
              control={
                fix === undefined ? undefined : (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => copyToClipboard(fix, undefined)}
                  >
                    Copy fix
                  </Button>
                )
              }
            />
          );
        })}
      </SettingsGroup>
    </SettingsSection>
  );
}
