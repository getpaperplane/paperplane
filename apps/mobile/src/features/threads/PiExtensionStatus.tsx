import type { EnvironmentId, ThreadId } from "@rove-code/contracts";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { piExtensionStatusEnvironment } from "../../state/piExtensionStatus";
import { useEnvironmentQuery } from "../../state/query";

/**
 * Pi extension status lines above the composer. Mount only for Pi threads: the
 * subscription lives exactly as long as this component. Renders nothing while
 * empty, loading, or failed.
 */
export function PiExtensionStatus({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const query = useEnvironmentQuery(
    piExtensionStatusEnvironment.snapshot({ environmentId, input: { threadId } }),
  );
  const statuses = query.isSuccess ? (query.data?.statuses ?? []) : [];
  if (statuses.length === 0) return null;

  return (
    <View className="gap-0.5 px-2 pb-1.5">
      {statuses.map(({ key, text }) => (
        <Text key={key} numberOfLines={1} className="text-[12px] text-foreground-muted">
          {text.split("\n")[0]}
        </Text>
      ))}
    </View>
  );
}
