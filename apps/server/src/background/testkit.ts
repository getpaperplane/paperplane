import type { BackgroundPolicySnapshot } from "@getpaperplane/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as BackgroundPolicy from "./BackgroundPolicy.ts";

export function policySnapshot(active: boolean): BackgroundPolicySnapshot {
  const now = DateTime.makeUnsafe(0);
  return {
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: now,
    },
    leases: [],
    activeForegroundLeaseCount: active ? 1 : 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: active,
    updatedAt: now,
  };
}

export const layerPolicy = (active = true) =>
  Layer.mock(BackgroundPolicy.BackgroundPolicy)({
    snapshot: Effect.succeed(policySnapshot(active)),
    shouldRunOpportunisticWork: Effect.succeed(active),
    subscribe: Effect.succeed({ latest: policySnapshot(active), changes: Stream.empty }),
  });
