import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { scopeThreadRef } from "@rove-code/client-runtime/environment";
import {
  resolveLatestContinuation,
  renderHandoffContext,
} from "@rove-code/client-runtime/threadHandoff";
import type { EnvironmentId, OrchestrationThreadShell, ThreadHandoff } from "@rove-code/contracts";
import { useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { environmentThreadDetails } from "../../state/threads";
import { useContinueThreadOnEnvironment } from "./use-continue-thread-on-environment";

export function HandoffDraftNotice({
  handoff,
  onRemove,
}: {
  handoff: ThreadHandoff;
  onRemove: () => void;
}) {
  const [reviewing, setReviewing] = useState(false);
  return (
    <View className="gap-2 px-2 py-2">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Review continuation context"
        onPress={() => setReviewing(true)}
      >
        <Text className="text-sm font-rove-medium text-foreground">
          Continue from {handoff.sourceLabel}
        </Text>
        <Text className="text-xs text-foreground-muted">
          {handoff.branch} at {handoff.commitSha.slice(0, 7)} · {handoff.items.length} context items
          · Review context
        </Text>
        <Text className="text-xs text-foreground-muted">
          {handoff.codeOnly
            ? "Code only: no conversation or attachments transferred"
            : `${handoff.omittedItems} items and ${handoff.omittedAttachments} attachments not transferred`}
        </Text>
      </Pressable>
      <Modal
        visible={reviewing}
        presentationStyle="pageSheet"
        onRequestClose={() => setReviewing(false)}
      >
        <View className="flex-1 bg-sheet px-4 pb-4 pt-12">
          <View className="flex-row justify-between pb-4">
            <Pressable
              accessibilityRole="button"
              onPress={() => {
                onRemove();
                setReviewing(false);
              }}
            >
              <Text className="text-sm text-foreground-muted">Remove handoff</Text>
            </Pressable>
            <Pressable accessibilityRole="button" onPress={() => setReviewing(false)}>
              <Text className="text-sm font-rove-medium text-foreground">Done</Text>
            </Pressable>
          </View>
          <ScrollView>
            <Text selectable className="text-sm text-foreground">
              {renderHandoffContext(handoff, 128_000)}
            </Text>
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

/** The same action and lineage navigation are reachable from chat on both mobile platforms. */
export function ThreadContinuationControl({
  environmentId,
  thread,
}: {
  environmentId: EnvironmentId;
  thread: OrchestrationThreadShell;
}) {
  const navigation = useNavigation();
  const [choosing, setChoosing] = useState(false);
  const continuation = useContinueThreadOnEnvironment();
  const detail = useAtomValue(
    environmentThreadDetails.detailAtom(scopeThreadRef(environmentId, thread.id)),
  );
  const link = resolveLatestContinuation(detail?.activities ?? []);
  const scoped = { ...thread, environmentId };
  const targets = continuation.resolveTargets(scoped);
  if (targets.length === 0 && !link) return null;
  return (
    <View className="gap-1 px-4 py-2">
      {link ? (
        <Pressable
          accessibilityRole="button"
          onPress={() =>
            navigation.navigate("Thread", {
              environmentId: link.environmentId,
              threadId: link.threadId,
            })
          }
        >
          <Text className="text-sm text-foreground-muted">
            Continued {link.direction === "from" ? "from" : "on"} {link.environmentLabel} · Open{" "}
            {link.direction === "from" ? "original" : "continuation"}
          </Text>
        </Pressable>
      ) : null}
      {targets.length > 0 ? (
        <Pressable accessibilityRole="button" onPress={() => setChoosing(true)}>
          <Text className="text-sm font-rove-medium text-foreground">
            Continue on another machine…
          </Text>
        </Pressable>
      ) : null}
      <Modal
        visible={choosing}
        presentationStyle="pageSheet"
        onRequestClose={() => setChoosing(false)}
      >
        <View className="flex-1 gap-4 bg-sheet px-4 pb-4 pt-12">
          <Pressable accessibilityRole="button" onPress={() => setChoosing(false)}>
            <Text className="text-sm text-foreground-muted">Cancel</Text>
          </Pressable>
          <Text className="text-lg font-rove-medium text-foreground">Continue on</Text>
          <Text className="text-sm text-foreground-muted">
            Create a continuation draft on another machine. Nothing runs until you review and send
            it.
          </Text>
          <ScrollView>
            {targets.map((target) => (
              <Pressable
                key={`${target.environmentId}:${target.projectId}`}
                accessibilityRole="button"
                onPress={() => {
                  setChoosing(false);
                  void continuation.continueOn(scoped, target);
                }}
              >
                <Text className="py-3 text-base text-foreground">{target.label}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}
