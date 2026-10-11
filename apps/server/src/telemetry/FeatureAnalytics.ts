import { ORCHESTRATION_WS_METHODS, WS_METHODS } from "@rove-code/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { AnalyticsService } from "./AnalyticsService.ts";

// Explicit operations only: never terminal writes, device input, file contents,
// heartbeat/polling requests, or RPC arguments/results/trace attributes.
interface FeatureOperation {
  readonly feature: string;
  readonly action: string;
  readonly once?: boolean;
}

type FeatureOperations = Readonly<Record<string, FeatureOperation>>;

const Operations = {
  [WS_METHODS.terminalOpen]: { feature: "terminal", action: "open" },
  [WS_METHODS.terminalRestart]: { feature: "terminal", action: "restart" },
  [WS_METHODS.terminalClose]: { feature: "terminal", action: "close" },
  [WS_METHODS.reviewGetDiffPreview]: { feature: "diff", action: "review", once: true },
  [ORCHESTRATION_WS_METHODS.getTurnDiff]: { feature: "diff", action: "turn", once: true },
  [ORCHESTRATION_WS_METHODS.getFullThreadDiff]: { feature: "diff", action: "thread", once: true },
  [ORCHESTRATION_WS_METHODS.searchThreads]: { feature: "search", action: "threads", once: true },
  [WS_METHODS.projectsSearchContents]: { feature: "search", action: "contents", once: true },
  [WS_METHODS.projectsSearchEntries]: { feature: "search", action: "files", once: true },
  [WS_METHODS.vcsCreateWorktree]: { feature: "worktree", action: "create" },
  [WS_METHODS.vcsRemoveWorktree]: { feature: "worktree", action: "remove" },
  [WS_METHODS.worktreeInventoryRemove]: { feature: "worktree", action: "cleanup" },
  [WS_METHODS.gitRunStackedAction]: { feature: "source-control", action: "stacked-action" },
  [WS_METHODS.vcsPull]: { feature: "source-control", action: "pull" },
  [WS_METHODS.previewOpen]: { feature: "browser", action: "open" },
  [WS_METHODS.previewClose]: { feature: "browser", action: "close" },
  [WS_METHODS.deviceOpen]: { feature: "device", action: "open" },
  [WS_METHODS.deviceClose]: { feature: "device", action: "close" },
  [WS_METHODS.projectsAdd]: { feature: "project", action: "add" },
  [WS_METHODS.agentSessionsImport]: { feature: "session-import", action: "import" },
  [WS_METHODS.providerInstallStart]: { feature: "provider-setup", action: "install" },
  [WS_METHODS.providerAuthStart]: { feature: "provider-setup", action: "authenticate" },
} satisfies FeatureOperations;
const operationDescriptors = new Map<string, FeatureOperation>(Object.entries(Operations));

/** Per-connection attribution, with read-heavy features counted once per socket. */
export function makeFeatureAnalytics(
  analytics: AnalyticsService["Service"],
  clientProperties: Parameters<AnalyticsService["Service"]["record"]>[1],
) {
  const observedReads = new Set<string>();
  return <A, E, R>(method: string, operation: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => {
    const descriptor = operationDescriptors.get(method);
    if (!descriptor) return operation;
    return Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      return yield* operation.pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (descriptor.once && observedReads.has(method)) return;
            if (descriptor.once) observedReads.add(method);
            const endedAt = yield* Clock.currentTimeMillis;
            yield* analytics
              .record("client.feature.used", {
                ...clientProperties,
                feature: descriptor.feature,
                action: descriptor.action,
                outcome: Exit.isSuccess(exit)
                  ? "succeeded"
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? "cancelled"
                    : "failed",
                durationMs: Math.max(0, endedAt - startedAt),
              })
              .pipe(Effect.ignoreCause);
          }),
        ),
      );
    });
  };
}
