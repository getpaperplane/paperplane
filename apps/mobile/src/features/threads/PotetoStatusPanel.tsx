import { useAtomCommand } from "../../state/use-atom-command";
import { threadEnvironment } from "../../state/threads";
import {
  potetoArtifactPreview,
  type PotetoActivityArtifact,
} from "@rove-code/client-runtime/poteto";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@rove-code/client-runtime/state/runtime";
import type { EnvironmentId, PotetoProgress, ThreadId } from "@rove-code/contracts";
import { useState } from "react";
import { Alert, Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { AppText } from "../../components/AppText";
import { RequestActionButton } from "./RequestActionButton";

const PHASE_LABELS = {
  reproduce: "Reproduce",
  investigate: "Investigate",
  design: "Design",
  implement: "Implement",
  verify: "Verify",
  review: "Review",
} as const;

export function PotetoStatusPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly progress: PotetoProgress | null;
  readonly artifacts: ReadonlyArray<PotetoActivityArtifact>;
  readonly pending: boolean;
}) {
  const { height } = useWindowDimensions();
  const [controlling, setControlling] = useState(false);
  const [reportsExpanded, setReportsExpanded] = useState(false);
  const [patchExpanded, setPatchExpanded] = useState(false);
  const controlPoteto = useAtomCommand(threadEnvironment.controlPoteto, { reportFailure: false });
  const progress = props.progress;
  if (!progress) return null;

  const active = progress.status === "requested" || progress.status === "running";
  const retryable =
    !props.pending &&
    (progress.status === "blocked" ||
      progress.status === "interrupted" ||
      progress.status === "cancelled");
  const phaseLabel = progress.phase ? PHASE_LABELS[progress.phase] : active ? "Preparing" : "";
  const patch = progress.status === "candidate-ready" ? progress.patch : undefined;
  const patchPreview =
    patch && patch.length > 24_000 ? `${patch.slice(0, 24_000)}\n… patch preview truncated` : patch;
  const latestArtifact = props.artifacts.at(-1);

  const handleControl = async (action: "cancel" | "retry") => {
    if (controlling) return;
    setControlling(true);
    const result = await controlPoteto({
      environmentId: props.environmentId,
      input: { threadId: props.threadId, runId: progress.runId, action },
    });
    setControlling(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      Alert.alert(
        action === "cancel" ? "Could not stop Poteto Mode" : "Could not retry Poteto Mode",
        error instanceof Error ? error.message : "The request was rejected.",
      );
    }
  };

  return (
    <ScrollView
      nestedScrollEnabled
      style={{ maxHeight: Math.round(height * 0.45) }}
      className="mx-3 mb-2 rounded-xl border border-border-subtle bg-composer-panel"
      contentContainerClassName="gap-2 p-3"
    >
      <View className="flex-row flex-wrap items-center gap-2">
        <AppText className="text-sm font-rove-semibold">Poteto Mode</AppText>
        <AppText className="rounded-md bg-subtle px-2 py-1 text-xs font-rove-medium">
          {progress.status === "candidate-ready" ? "Candidate ready" : progress.status}
        </AppText>
        <AppText className="text-xs text-foreground-muted">{phaseLabel}</AppText>
        <View className="ml-auto flex-row gap-2">
          {active ? (
            <RequestActionButton
              label={controlling ? "Stopping…" : "Stop"}
              tone="secondary"
              disabled={controlling}
              onPress={() => void handleControl("cancel")}
            />
          ) : null}
          {retryable ? (
            <RequestActionButton
              label={controlling ? "Retrying…" : "Retry"}
              tone="secondary"
              disabled={controlling}
              onPress={() => void handleControl("retry")}
            />
          ) : null}
        </View>
      </View>
      {progress.reason ? (
        <AppText className="text-sm text-warning-foreground">{progress.reason}</AppText>
      ) : null}
      {progress.baseCommit || progress.revision ? (
        <View className="gap-1">
          {progress.baseCommit ? (
            <AppText selectable className="text-xs text-foreground-muted">
              Base {progress.baseCommit}
            </AppText>
          ) : null}
          {progress.revision ? (
            <AppText selectable className="text-xs text-foreground-muted">
              Revision {progress.revision}
            </AppText>
          ) : null}
        </View>
      ) : null}
      {latestArtifact ? (
        <AppText numberOfLines={2} className="text-xs text-foreground-secondary">
          {potetoArtifactPreview(latestArtifact.artifact) ?? `${phaseLabel} report`}
        </AppText>
      ) : null}
      {props.artifacts.length > 0 ? (
        <View className="gap-2">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: reportsExpanded }}
            onPress={() => setReportsExpanded((expanded) => !expanded)}
          >
            <AppText className="text-xs font-rove-medium text-foreground-muted">
              {reportsExpanded ? "Hide" : "Evidence and reports"} ({props.artifacts.length})
            </AppText>
          </Pressable>
          {reportsExpanded ? (
            <View className="gap-2">
              {props.artifacts.map((entry) => (
                <View key={entry.id} className="gap-1 rounded-lg bg-subtle px-2.5 py-2">
                  <AppText className="text-xs font-rove-medium">
                    {entry.phase ? PHASE_LABELS[entry.phase] : "Poteto report"}
                  </AppText>
                  <ScrollView nestedScrollEnabled className="max-h-40">
                    <AppText selectable className="font-mono text-xs text-foreground-muted">
                      {JSON.stringify(entry.artifact, null, 2)}
                    </AppText>
                  </ScrollView>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
      {progress.status === "candidate-ready" ? (
        patchPreview ? (
          <View className="gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: patchExpanded }}
              onPress={() => setPatchExpanded((expanded) => !expanded)}
            >
              <AppText className="text-xs font-rove-medium text-foreground-muted">
                {patchExpanded ? "Hide candidate patch" : "View candidate patch"}
              </AppText>
            </Pressable>
            {patchExpanded ? (
              <ScrollView nestedScrollEnabled className="max-h-64 rounded-lg bg-subtle p-2">
                <AppText selectable className="font-mono text-xs text-foreground">
                  {patchPreview}
                </AppText>
              </ScrollView>
            ) : null}
            <AppText className="text-xs text-foreground-muted">
              Reviewed candidate only. This patch has not been applied.
            </AppText>
          </View>
        ) : (
          <AppText className="text-xs text-foreground-muted">
            No patch was attached to this candidate.
          </AppText>
        )
      ) : null}
    </ScrollView>
  );
}
