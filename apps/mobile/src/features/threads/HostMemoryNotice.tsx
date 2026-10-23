import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { hostMemoryNotice } from "@rove-code/client-runtime/host-health";
import type { EnvironmentId } from "@rove-code/contracts";
import { Pressable } from "react-native";

import { Notice } from "../../components/ui/Notice";
import { serverEnvironment } from "../../state/server";

/**
 * Above the composer while the thread's environment is under memory pressure. Mount only when
 * the server advertises `hostHealth`; the subscription ends when this unmounts.
 */
export function HostMemoryNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const navigation = useNavigation();
  const result = useAtomValue(
    serverEnvironment.hostHealth({ environmentId: props.environmentId, input: {} }),
  );
  const notice = result._tag === "Success" ? hostMemoryNotice(result.value) : null;
  if (notice === null) return null;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityHint="Opens environment details"
      className="px-4 pb-3 active:opacity-70"
      onPress={() =>
        navigation.navigate("SettingsSheet", {
          screen: "SettingsContent",
          params: {
            screen: "SettingsEnvironmentDetail",
            params: { environmentId: props.environmentId },
          },
        })
      }
    >
      <Notice
        message={`${props.environmentLabel} is low on memory (${notice.freeLabel}). Paperplane releases idle agents first; new work may be slow or killed.`}
        icon="exclamationmark.triangle"
        floating
      />
    </Pressable>
  );
}
