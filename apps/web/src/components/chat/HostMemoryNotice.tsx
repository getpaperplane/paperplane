import { useAtomValue } from "@effect/atom-react";
import { hostMemoryNotice } from "@rove-code/client-runtime/host-health";
import type { EnvironmentId, HostHealthReport } from "@rove-code/contracts";
import { Link } from "@tanstack/react-router";
import { AsyncResult, Atom } from "effect/reactivity";
import { MemoryStickIcon } from "lucide-react";
import { useMemo } from "react";

import { serverEnvironment } from "../../state/server";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

const NO_HOST_HEALTH_ATOM = Atom.make(AsyncResult.initial<HostHealthReport, never>()).pipe(
  Atom.withLabel("web-host-health:none"),
);

/**
 * Composer notice for a thread environment under memory pressure. Subscribes only while the
 * composer is mounted and the server advertises `hostHealth`; older servers never subscribe.
 */
export function useHostMemoryBannerItem(
  environment: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly supportsHostHealth: boolean;
  } | null,
): ComposerBannerStackItem | null {
  const environmentId = environment?.supportsHostHealth ? environment.environmentId : null;
  const result = useAtomValue(
    environmentId === null
      ? NO_HOST_HEALTH_ATOM
      : serverEnvironment.hostHealth({ environmentId, input: {} }),
  );
  const freeLabel =
    result._tag === "Success" ? (hostMemoryNotice(result.value)?.freeLabel ?? null) : null;
  const label = environment?.label ?? null;
  return useMemo(() => {
    if (environmentId === null || label === null || freeLabel === null) return null;
    return {
      id: `host-memory:${environmentId}`,
      variant: "warning",
      priority: "notice",
      icon: <MemoryStickIcon />,
      title: `${label} is low on memory (${freeLabel})`,
      description: "Rove releases idle agents first; new work may be slow or killed.",
      actions: (
        <Button
          size="xs"
          variant="ghost"
          render={<Link to="/settings/diagnostics" search={{ machine: environmentId }} />}
        >
          Details
        </Button>
      ),
    };
  }, [environmentId, freeLabel, label]);
}
