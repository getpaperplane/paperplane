import * as Layer from "effect/Layer";
import * as PiExtensionStatuses from "./PiExtensionStatuses.ts";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CursorAgentSdk from "@getpaperplane/provider-cursor/server/CursorAgentSdk";
import * as CursorSdk from "@getpaperplane/provider-cursor/server/CursorSdk";
import * as CursorKeychain from "@getpaperplane/provider-cursor/server/CursorKeychain";
import * as IdAllocator from "@getpaperplane/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@getpaperplane/provider-core/server/ProviderContinuationRequests";

export type ProviderOrchestrationAdapterInfrastructure =
  | ClaudeAdapterV2.ClaudeAgentSdkQueryRunner
  | CodexAdapterV2.CodexAppServerClientFactory
  | CursorAgentSdk.CursorAgentSdkRunner
  | CursorSdk.CursorSdk
  | CursorKeychain.CursorKeychain
  | IdAllocator.IdAllocatorV2
  | PiExtensionStatuses.PiExtensionStatuses;

/**
 * Infrastructure shared by the V2 adapters materialized inside provider
 * instances. `providerContinuationRequestsLayer` must be the same layer
 * reference the orchestration runtime provides to its continuation worker so
 * Effect layer memoization yields one shared queue.
 */
export const layer = Layer.mergeAll(
  ClaudeAdapterV2.layerQueryRunner,
  CodexAdapterV2.layerAppServerClientFactory,
  CursorAgentSdk.layer.pipe(Layer.provideMerge(CursorSdk.layer)),
  CursorKeychain.layer,
  IdAllocator.layer,
  ProviderContinuationRequests.layer,
  PiExtensionStatuses.layer,
);
