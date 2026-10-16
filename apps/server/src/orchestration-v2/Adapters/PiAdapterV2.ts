/** Rove's V2 Pi adapter. Only the injected SDK session boundary crosses IPC (ADR 0001). */
import type {
  OrchestrationV2ConversationMessage,
  ModelSelection,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  OrchestrationV2ExecutionNode,
  OrchestrationV2RuntimeRequest,
  OrchestrationV2Subagent,
  ProviderInstanceId,
} from "@rove-code/contracts";
import { OrchestrationV2UserInputQuestion, RuntimeRequestId } from "@rove-code/contracts";
import * as ProviderAdapter from "@rove-code/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@rove-code/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@rove-code/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@rove-code/provider-core/server/mcpSession";
import { turnScopedSelectionTransition } from "@rove-code/provider-core/server/selectionTransition";
import { makeProviderFailure } from "@rove-code/provider-core/server/failure";
import { ProviderDriverKind } from "@rove-code/contracts";
import { getModelSelectionStringOptionValue } from "@rove-code/shared/model";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import { makeProviderTextDeltaCoalescer } from "./ProviderTextDeltaCoalescer.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import { acquirePiResource, disposePiResource } from "../../provider/Layers/PiLifecycle.ts";
import {
  piContextUsage,
  resolvePiToolCallArgs,
  translatePiSkillToken,
  type PiCreateSessionInput,
  type PiSessionLike,
  type PiSessionEventLike,
  type PiImageContentLike,
} from "../../provider/Layers/PiAdapter.ts";
import { piRecord, piTrimmed } from "../../provider/Layers/PiValues.ts";

export const PI_PROVIDER = ProviderDriverKind.make("pi");
export const PiProviderCapabilitiesV2 = {
  runtimePolicy: { enforcement: "native" },
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: true,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: true,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: true,
    supportsDynamicToolCallbacks: true,
  },
  approvals: {
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: true,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: true,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: false,
    providerCanRollbackConversation: true,
    providerRollbackReturnsSnapshot: true,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "strong",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
} satisfies OrchestrationV2ProviderCapabilities;

export interface PiAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly defaultModel?: string | undefined;
  readonly defaultThinkingLevel?: string | null | undefined;
  readonly createSession: (
    input: PiCreateSessionInput,
    mcp: McpProviderSessionConfig | undefined,
  ) => Promise<PiSessionLike>;
}
const decodeQuestions = Schema.decodeUnknownSync(Schema.Array(OrchestrationV2UserInputQuestion));
const contentText = (value: unknown): string => {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((block) => {
      const b = piRecord(block);
      return b?.type === "text" && typeof b.text === "string" ? b.text : "";
    })
    .join("");
};
const sessionIdFromFile = (file: string) =>
  file
    .replace(/\.jsonl$/, "")
    .split(/[\\/]/)
    .at(-1)
    ?.split("_")
    .at(-1) ?? file;

export const makePiAdapterV2 = Effect.fn("makePiAdapterV2")(function* (
  options: PiAdapterV2Options,
) {
  const ids = yield* IdAllocator.IdAllocatorV2;
  const fs = yield* FileSystem.FileSystem;
  const config = yield* ServerConfig;
  const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: PI_PROVIDER,
    getCapabilities: () => Effect.succeed(PiProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("PiAdapterV2.openSession")(function* (input) {
      const scope = yield* Effect.scope;
      if (input.runtimePolicy.runtimeMode !== "full-access")
        return yield* new ProviderAdapter.ProviderAdapterProtocolError({
          driver: PI_PROVIDER,
          detail: "The SDK Pi runtime supports full-access only",
        });
      const queue = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
      const inbound = yield* Queue.unbounded<PiSessionEventLike>();
      const permit = yield* Semaphore.make(1);
      const sendPermit = yield* Semaphore.make(1);
      const now = yield* DateTime.now;
      const sessionEntity = {
        id: input.providerSessionId,
        driver: PI_PROVIDER,
        providerInstanceId: options.instanceId,
        status: "ready" as const,
        cwd: input.runtimePolicy.cwd ?? config.cwd,
        model: input.modelSelection.model,
        capabilities: PiProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      let session: PiSessionLike | undefined;
      let thread: OrchestrationV2ProviderThread | undefined;
      let active:
        | {
            input: ProviderAdapter.ProviderAdapterV2TurnInput;
            turn: OrchestrationV2ProviderTurn;
            items: Map<string, OrchestrationV2TurnItem>;
            messageIndex: number;
            ordinal: number;
            interrupted: boolean;
            requestedInterrupt: boolean;
            broken: boolean;
            initialEntryIds: Set<string>;
            settled: Deferred.Deferred<void>;
            error: string | undefined;
          }
        | undefined;
      let closed = false;
      const turns = new Map<string, OrchestrationV2ProviderTurn>();
      const requests = new Map<
        RuntimeRequestId,
        {
          request: OrchestrationV2RuntimeRequest;
          item: Extract<OrchestrationV2TurnItem, { type: "user_input_request" }>;
          node: OrchestrationV2ExecutionNode;
        }
      >();
      const children = new Map<string, OrchestrationV2Subagent>();
      const ref = (nativeId: string) => ({
        driver: PI_PROVIDER,
        nativeId,
        strength: "strong" as const,
      });
      const protocol = (detail: string) =>
        new ProviderAdapter.ProviderAdapterProtocolError({ driver: PI_PROVIDER, detail });
      const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
        Queue.offer(queue, event).pipe(Effect.asVoid);
      const publishThread = Effect.fn("PiAdapterV2.publishThread")(function* () {
        if (!thread || !session) return;
        thread = {
          ...thread,
          nativeThreadRef: ref(session.sessionFile ?? session.sessionId),
          nativeConversationHeadRef: session.getLeafId?.() ? ref(session.getLeafId()!) : null,
          contextUsage: piContextUsage(session),
          updatedAt: yield* DateTime.now,
        };
        yield* emit({
          type: "provider_thread.updated",
          driver: PI_PROVIDER,
          providerThread: thread,
        });
      });
      const create = Effect.fn("PiAdapterV2.create")(
        function* (selection: ModelSelection, nativeFile?: string) {
          if (closed) return yield* protocol("Pi runtime is closed");
          const mcp = yield* mcpSessions.read(input.threadId);
          const resource = yield* acquirePiResource(
            () =>
              options.createSession(
                {
                  threadId: input.threadId,
                  interactive: true,
                  cwd: input.runtimePolicy.cwd ?? config.cwd,
                  model: selection.model.trim() || options.defaultModel || undefined,
                  thinkingLevel:
                    getModelSelectionStringOptionValue(selection, "thinkingLevel") ??
                    options.defaultThinkingLevel ??
                    undefined,
                  resumeSessionId: nativeFile ? sessionIdFromFile(nativeFile) : undefined,
                  ...(nativeFile ? { resumeSessionFile: nativeFile } : {}),
                },
                mcp,
              ),
            (s) => s.dispose(),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterOpenSessionError({
                  driver: PI_PROVIDER,
                  providerSessionId: input.providerSessionId,
                  cause,
                }),
            ),
          );
          session = resource;
          if (resource.modelFallbackMessage)
            Queue.offerUnsafe(inbound, {
              type: "rove_model_fallback",
              error: resource.modelFallbackMessage,
            });
          const unsubscribe = resource.subscribe((event) => {
            Queue.offerUnsafe(inbound, event);
          });
          yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
          yield* Effect.addFinalizer(() => disposePiResource(() => resource.dispose()));
          return resource;
        },
        Effect.provideService(Scope.Scope, scope),
      );
      const load = Effect.fn("PiAdapterV2.load")(function* (
        existing: OrchestrationV2ProviderThread | undefined,
        selection: ModelSelection,
      ) {
        if (thread) {
          if (existing && existing.id !== thread.id)
            return yield* protocol("One SDK session cannot activate two provider threads");
          return thread;
        }
        const nativeFile = existing?.nativeThreadRef?.nativeId ?? input.initialNativeThreadId;
        const resource = yield* create(selection, nativeFile);
        const at = yield* DateTime.now;
        thread = existing
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              status: "idle",
              updatedAt: at,
            }
          : {
              id: ids.derive.providerThread({
                driver: PI_PROVIDER,
                providerInstanceId: options.instanceId,
                nativeThreadId: resource.sessionFile ?? resource.sessionId,
              }),
              driver: PI_PROVIDER,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: input.threadId,
              ownerNodeId: null,
              nativeThreadRef: ref(resource.sessionFile ?? resource.sessionId),
              nativeConversationHeadRef: resource.getLeafId?.() ? ref(resource.getLeafId()!) : null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: at,
              updatedAt: at,
            };
        yield* publishThread();
        return thread!;
      });
      const baseItem = (key: string, at: DateTime.Utc) => {
        if (!active) throw new Error("No Pi turn owns this item");
        const nativeId = `${active.turn.providerThreadId}:${active.turn.id}:${key}`;
        const existing = active.items.get(key);
        return {
          id: ids.derive.turnItemFromProviderItem({ driver: PI_PROVIDER, nativeItemId: nativeId }),
          threadId: active.input.threadId,
          runId: active.input.runId,
          nodeId: ids.derive.nodeFromProviderItem({ driver: PI_PROVIDER, nativeItemId: nativeId }),
          providerThreadId: active.turn.providerThreadId,
          providerTurnId: active.turn.id,
          nativeItemRef: ref(nativeId),
          parentItemId: null,
          ordinal: existing?.ordinal ?? ++active.ordinal,
          status: "running" as const,
          title: null,
          startedAt: existing?.startedAt ?? at,
          completedAt: null,
          updatedAt: at,
        };
      };
      const itemNode = (
        item: OrchestrationV2TurnItem,
        kind: OrchestrationV2ExecutionNode["kind"],
      ): OrchestrationV2ExecutionNode => ({
        id: item.nodeId!,
        threadId: item.threadId,
        runId: item.runId,
        parentNodeId: active!.input.rootNodeId,
        rootNodeId: active!.input.rootNodeId,
        kind,
        status:
          item.status === "waiting"
            ? "waiting"
            : item.status === "failed"
              ? "failed"
              : item.status === "completed"
                ? "completed"
                : item.status === "cancelled"
                  ? "cancelled"
                  : item.status === "interrupted"
                    ? "interrupted"
                    : "running",
        countsForRun: false,
        providerThreadId: item.providerThreadId ?? null,
        providerTurnId: item.providerTurnId,
        nativeItemRef: item.nativeItemRef,
        runtimeRequestId: item.type === "user_input_request" ? item.requestId : null,
        checkpointScopeId: null,
        startedAt: item.startedAt,
        completedAt: item.completedAt,
      });
      const putItem = Effect.fn("PiAdapterV2.putItem")(function* (
        key: string,
        item: OrchestrationV2TurnItem,
        kind: OrchestrationV2ExecutionNode["kind"],
      ) {
        if (!active) return;
        active.items.set(key, item);
        yield* emit({ type: "node.updated", driver: PI_PROVIDER, node: itemNode(item, kind) });
        yield* emit({ type: "turn_item.updated", driver: PI_PROVIDER, turnItem: item });
        if (item.type === "assistant_message")
          yield* emit({
            type: "message.updated",
            driver: PI_PROVIDER,
            message: {
              id: item.messageId,
              threadId: item.threadId,
              runId: item.runId,
              nodeId: item.nodeId,
              role: "assistant",
              text: item.text,
              attachments: item.attachments ?? [],
              streaming: item.streaming,
              createdBy: "agent",
              creationSource: "provider",
              createdAt: item.startedAt ?? item.updatedAt,
              updatedAt: item.updatedAt,
            },
          });
      });
      const textCoalescer = yield* makeProviderTextDeltaCoalescer({
        flushIntervalMs: 50,
        emit: (update) =>
          Effect.gen(function* () {
            if (!active || active.turn.id !== update.turnId) return;
            const item = active.items.get(update.itemId);
            if (item?.type !== "assistant_message" && item?.type !== "reasoning") return;
            const at = yield* DateTime.now;
            yield* putItem(
              update.itemId,
              {
                ...item,
                text: update.text,
                streaming: !update.completed,
                status: update.completed ? "completed" : "running",
                completedAt: update.completed ? at : null,
                updatedAt: at,
              },
              item.type,
            );
          }),
      });
      const finish = Effect.fn("PiAdapterV2.finish")(function* () {
        if (!active || !thread || !session) return;
        const current = active;
        yield* textCoalescer.flushTurn(current.turn.id);
        const at = yield* DateTime.now;
        const status = current.interrupted ? "interrupted" : current.error ? "failed" : "completed";
        for (const [key, item] of current.items) {
          if (item.status !== "running" && item.status !== "waiting") continue;
          const completed: OrchestrationV2TurnItem = {
            ...item,
            status,
            completedAt: at,
            updatedAt: at,
          };
          const finalized =
            "streaming" in completed ? { ...completed, streaming: false } : completed;
          yield* putItem(
            key,
            finalized,
            item.type === "reasoning"
              ? "reasoning"
              : item.type === "assistant_message"
                ? "assistant_message"
                : "tool_call",
          );
        }
        const branch = session.getBranch?.() ?? [];
        const lastUser =
          branch.find(
            (entry) => entry.message?.role === "user" && !current.initialEntryIds.has(entry.id),
          ) ?? branch.findLast((entry) => entry.message?.role === "user");
        const usage = piContextUsage(session);
        current.turn = {
          ...current.turn,
          status,
          completedAt: at,
          nativeTurnRef: lastUser ? ref(lastUser.id) : current.turn.nativeTurnRef,
          ...("usedTokens" in usage
            ? {
                tokenUsage: {
                  usedTokens: usage.usedTokens,
                  maxTokens: usage.maxTokens,
                  updatedAt: DateTime.formatIso(at),
                },
              }
            : {}),
        };
        turns.set(current.turn.id, current.turn);
        yield* emit({
          type: "provider_turn.updated",
          driver: PI_PROVIDER,
          threadId: input.threadId,
          providerTurn: current.turn,
        });
        thread = {
          ...thread,
          status: current.broken ? "error" : "idle",
          lastRunOrdinal: current.input.runOrdinal,
        };
        yield* publishThread();
        if (status === "failed") {
          const limit = yield* Effect.tryPromise(
            () =>
              session!.getTurnUsageLimit?.(current.error!, DateTime.formatIso(at)) ??
              Promise.resolve(null),
          ).pipe(Effect.orElseSucceed(() => null));
          const failure = makeProviderFailure({
            class: current.broken ? "transport_error" : limit ? "usage_limit" : "provider_error",
            message: current.error,
            ...(limit ? { resetAt: limit.resetAt } : {}),
          });
          yield* emit({
            type: "turn.terminal",
            driver: PI_PROVIDER,
            providerThreadId: thread.id,
            providerTurnId: current.turn.id,
            runOrdinal: current.input.runOrdinal,
            failureItemOrdinal: ++current.ordinal,
            status: "failed",
            failure,
            threadDisposition: current.broken ? "broken" : "reusable",
          });
        } else
          yield* emit({
            type: "turn.terminal",
            driver: PI_PROVIDER,
            providerThreadId: thread.id,
            providerTurnId: current.turn.id,
            runOrdinal: current.input.runOrdinal,
            status,
            failure: null,
            threadDisposition: current.broken ? "broken" : "reusable",
          });
        active = undefined;
        yield* Deferred.succeed(current.settled, undefined);
      });
      const handle = Effect.fn("PiAdapterV2.handle")(function* (event: PiSessionEventLike) {
        if (closed || !session) return;
        if (event.type === "runtime_exited") {
          if (active) {
            active.error = piTrimmed(event.error) ?? "Pi SDK worker exited.";
            active.broken = true;
            yield* finish();
          }
          yield* emit({
            type: "provider_session.updated",
            driver: PI_PROVIDER,
            providerSession: {
              ...sessionEntity,
              status: "error",
              lastError: makeProviderFailure({ message: piTrimmed(event.error) }).message,
              updatedAt: yield* DateTime.now,
            },
          });
          return;
        }
        if (
          (event.type === "rove_prompt_error" || event.type === "rove_prompt_settled") &&
          event.turnId !== active?.turn.id
        )
          return;
        if (!active) {
          if (event.type === "extension_error" || event.type === "rove_model_fallback") {
            const at = yield* DateTime.now;
            const message = makeProviderFailure({ message: piTrimmed(event.error) }).message;
            const nativeId = `${input.providerSessionId}:extension:${piTrimmed(event.extensionPath) ?? message}`;
            yield* emit({
              type: "turn_item.updated",
              driver: PI_PROVIDER,
              turnItem: {
                id: ids.derive.turnItemFromProviderItem({
                  driver: PI_PROVIDER,
                  nativeItemId: nativeId,
                }),
                threadId: input.threadId,
                runId: null,
                nodeId: null,
                providerThreadId: thread?.id ?? null,
                providerTurnId: null,
                nativeItemRef: ref(nativeId),
                parentItemId: null,
                ordinal: 0,
                type: "system_notice",
                title: event.type === "rove_model_fallback" ? "Pi model selection" : "Pi extension",
                status: "completed",
                message,
                startedAt: at,
                completedAt: at,
                updatedAt: at,
              },
            });
          }
          // V2 requires a committed run before tools execute. Never fabricate V1 turns.
          if (event.type === "agent_start" || event.type === "turn_start")
            yield* disposePiResource(() => session!.abort());
          return;
        }
        const at = yield* DateTime.now;
        switch (event.type) {
          case "turn_start":
            active.error = undefined;
            active.interrupted = active.requestedInterrupt;
            return;
          case "message_start":
            if (piRecord(event.message)?.role === "assistant") active.messageIndex++;
            return;
          case "message_update": {
            const delta = piRecord(event.assistantMessageEvent);
            if (typeof delta?.delta !== "string") return;
            const reasoning = delta.type === "thinking_delta";
            if (!reasoning && delta.type !== "text_delta") return;
            const key = `${reasoning ? "reasoning" : "message"}:${active.messageIndex}`;
            const previous = active.items.get(key);
            const text = (previous && "text" in previous ? previous.text : "") + delta.delta;
            const base = baseItem(key, at);
            const item = reasoning
              ? { ...base, type: "reasoning" as const, text, streaming: true }
              : {
                  ...base,
                  type: "assistant_message" as const,
                  messageId: ids.derive.messageFromProviderItem({
                    driver: PI_PROVIDER,
                    nativeItemId: base.nativeItemRef!.nativeId,
                  }),
                  text,
                  streaming: true,
                };
            active.items.set(key, item);
            yield* textCoalescer.append({
              turnId: active.turn.id,
              itemId: key,
              delta: delta.delta,
            });
            return;
          }
          case "message_end": {
            const message = piRecord(event.message);
            if (message?.role !== "assistant") return;
            if (message.stopReason === "error")
              active.error = piTrimmed(message.errorMessage) ?? "Pi assistant response failed.";
            if (message.stopReason === "aborted") active.interrupted = true;
            const key = `message:${active.messageIndex}`;
            const text = contentText(message.content);
            const base = baseItem(key, at);
            active.items.set(key, {
              ...base,
              type: "assistant_message",
              messageId: ids.derive.messageFromProviderItem({
                driver: PI_PROVIDER,
                nativeItemId: base.nativeItemRef!.nativeId,
              }),
              text,
              streaming: false,
              status: "completed",
              completedAt: at,
            });
            yield* textCoalescer.complete({
              turnId: active.turn.id,
              itemId: key,
              finalText: text,
              emitEmpty: true,
            });
            const reasoningKey = `reasoning:${active.messageIndex}`;
            const reasoning = active.items.get(reasoningKey);
            if (reasoning?.type === "reasoning")
              yield* textCoalescer.complete({ turnId: active.turn.id, itemId: reasoningKey });
            return;
          }
          case "tool_execution_start":
          case "tool_execution_update":
          case "tool_execution_end": {
            const toolId = piTrimmed(event.toolCallId);
            if (!toolId) return;
            const key = `tool:${toolId}`;
            const name = piTrimmed(event.toolName) ?? "tool";
            const args = piRecord(event.args) ?? resolvePiToolCallArgs(session.messages, toolId);
            const base = baseItem(key, at);
            const terminal = event.type === "tool_execution_end";
            const status = terminal
              ? event.isError === true
                ? ("failed" as const)
                : ("completed" as const)
              : ("running" as const);
            const output = event.result ?? event.partialResult;
            const common = { ...base, status, title: name, completedAt: terminal ? at : null };
            const old = active.items.get(key);
            const item: OrchestrationV2TurnItem =
              name === "bash"
                ? {
                    ...common,
                    type: "command_execution",
                    input:
                      piTrimmed(args?.command) ??
                      (old?.type === "command_execution" ? old.input : name),
                    ...(output === undefined
                      ? {}
                      : { output: contentText(piRecord(output)?.content) }),
                  }
                : {
                    ...common,
                    type: "dynamic_tool",
                    toolName: name,
                    input: args ?? (old?.type === "dynamic_tool" ? old.input : {}),
                    ...(output === undefined ? {} : { output }),
                  };
            yield* putItem(key, item, "tool_call");
            return;
          }
          case "rove_ui_request": {
            const native = piTrimmed(event.requestId);
            if (!native) return;
            const requestId = yield* ids.allocate
              .runtimeRequest({
                driver: PI_PROVIDER,
                providerTurnId: active.turn.id,
                nativeRequestId: native,
              })
              .pipe(Effect.mapError((cause) => protocol(cause.message)));
            const questions = decodeQuestions(
              Array.isArray(event.questions)
                ? event.questions.map((value) => {
                    const question = piRecord(value);
                    return {
                      ...question,
                      options: Array.isArray(question?.options)
                        ? question.options.map((value) => {
                            const option = piRecord(value);
                            return { ...option, description: option?.description || option?.label };
                          })
                        : [],
                    };
                  })
                : [],
            );
            const key = `request:${native}`;
            const item = {
              ...baseItem(key, at),
              nodeId: ids.derive.approvalNode({ requestId }),
              type: "user_input_request" as const,
              status: "waiting" as const,
              requestId,
              questions,
            };
            const node = itemNode(item, "user_input_request");
            const request: OrchestrationV2RuntimeRequest = {
              id: requestId,
              nodeId: node.id,
              providerTurnId: active.turn.id,
              nativeRequestRef: ref(native),
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "live", providerSessionId: input.providerSessionId },
              createdAt: at,
              resolvedAt: null,
            };
            requests.set(requestId, { request, item, node });
            yield* putItem(key, item, "user_input_request");
            yield* emit({
              type: "runtime_request.updated",
              driver: PI_PROVIDER,
              threadId: input.threadId,
              runtimeRequest: request,
            });
            return;
          }
          case "rove_ui_resolved": {
            for (const entry of requests.values()) {
              if (
                entry.request.nativeRequestRef?.nativeId !== event.requestId ||
                entry.request.status !== "pending"
              )
                continue;
              const answers = piRecord(event.answers) ?? entry.request.answers ?? {};
              const cancelled = Object.keys(answers).length === 0;
              entry.request = {
                ...entry.request,
                status: cancelled ? "cancelled" : "resolved",
                resolvedAt: at,
                answers,
              };
              yield* emit({
                type: "runtime_request.updated",
                driver: PI_PROVIDER,
                threadId: input.threadId,
                runtimeRequest: entry.request,
              });
              yield* putItem(
                `request:${event.requestId}`,
                {
                  ...entry.item,
                  status: cancelled ? "cancelled" : "completed",
                  completedAt: at,
                  updatedAt: at,
                },
                "user_input_request",
              );
            }
            return;
          }
          case "rove_agent_task": {
            const task = piRecord(event.task),
              payload = piRecord(task?.payload);
            const native = piTrimmed(payload?.taskId);
            if (!native) return;
            const key = `subagent:${native}`,
              base = baseItem(key, at);
            const previous = children.get(native);
            const terminal = task?.type === "task.completed";
            const status = terminal
              ? payload?.status === "failed"
                ? "failed"
                : payload?.status === "stopped"
                  ? "cancelled"
                  : "completed"
              : "running";
            const child: OrchestrationV2Subagent = {
              id: base.nodeId!,
              threadId: input.threadId,
              runId: active.input.runId,
              parentNodeId: active.input.rootNodeId,
              origin: "provider_native",
              createdBy: "agent",
              driver: PI_PROVIDER,
              providerInstanceId: options.instanceId,
              providerThreadId: null,
              childThreadId: null,
              nativeTaskRef: ref(native),
              prompt: piTrimmed(payload?.description) ?? previous?.prompt ?? "",
              title: piTrimmed(payload?.title) ?? previous?.title ?? "Pi subagent",
              model: piTrimmed(payload?.model) ?? previous?.model ?? null,
              status,
              progress: piTrimmed(payload?.summary) ?? previous?.progress ?? "",
              result: terminal ? (piTrimmed(payload?.summary) ?? "") : null,
              startedAt: previous?.startedAt ?? at,
              completedAt: terminal ? at : null,
              updatedAt: at,
            };
            children.set(native, child);
            yield* emit({ type: "subagent.updated", driver: PI_PROVIDER, subagent: child });
            yield* putItem(
              key,
              {
                ...base,
                type: "subagent",
                status,
                title: child.title,
                completedAt: child.completedAt,
                subagentId: child.id,
                origin: child.origin,
                driver: PI_PROVIDER,
                providerInstanceId: options.instanceId,
                childThreadId: null,
                prompt: child.prompt,
                progress: child.progress,
                result: child.result,
              },
              "subagent",
            );
            return;
          }
          case "compaction_start":
          case "compaction_end": {
            const key = "compaction",
              complete = event.type === "compaction_end";
            yield* putItem(
              key,
              {
                ...baseItem(key, at),
                type: "compaction",
                driver: PI_PROVIDER,
                title: complete ? "Context compacted" : "Compacting context...",
                status: complete ? "completed" : "running",
                completedAt: complete ? at : null,
              },
              "system",
            );
            yield* publishThread();
            return;
          }
          case "rove_prompt_error":
          case "prompt_error":
            active.error = piTrimmed(event.error) ?? "Pi prompt failed.";
            return;
          case "agent_end":
            return; // retries and compaction are not root terminal signals
          case "rove_prompt_settled":
          case "agent_settled":
            if (!session.isStreaming && !session.isPreparingPrompt && !session.hasPendingUserInput)
              yield* finish();
            return;
          case "rove_ui_notify":
          case "rove_model_fallback":
          case "extension_error": {
            const message = piTrimmed(event.message) ?? piTrimmed(event.error);
            if (!message) return;
            const key = `notice:${active.ordinal + 1}`;
            yield* putItem(
              key,
              {
                ...baseItem(key, at),
                type: "system_notice",
                status: "completed",
                message,
                completedAt: at,
              },
              "system",
            );
            return;
          }
        }
      });
      yield* Queue.take(inbound).pipe(
        Effect.flatMap((event) => permit.withPermit(handle(event))),
        Effect.forever,
        Effect.forkScoped,
      );
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          closed = true;
          yield* Queue.shutdown(inbound);
          yield* Queue.shutdown(queue);
        }),
      );
      const nativeMessages = (): OrchestrationV2ConversationMessage[] => {
        if (!thread || !session) return [];
        return (session.getBranch?.() ?? []).flatMap((entry) => {
          const message = piRecord(piRecord(entry)?.message);
          if (message?.role !== "user" && message?.role !== "assistant") return [];
          return [
            {
              id: ids.derive.messageFromProviderItem({
                driver: PI_PROVIDER,
                nativeItemId: `${thread!.id}:entry:${entry.id}`,
              }),
              threadId: input.threadId,
              runId: null,
              nodeId: null,
              role: message.role,
              text: contentText(message.content),
              attachments: [],
              streaming: false,
              createdBy: message.role === "assistant" ? "agent" : "user",
              creationSource: "provider",
              createdAt: thread!.createdAt,
              updatedAt: thread!.updatedAt,
            },
          ];
        });
      };
      const snapshot = (): ProviderAdapter.ProviderAdapterV2ThreadSnapshot => ({
        providerThread: thread!,
        providerTurns: [...turns.values()],
        messages: nativeMessages(),
        runtimeRequests: [...requests.values()].map((entry) => entry.request),
        providerPayload: session?.messages,
      });
      const runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime = {
        instanceId: options.instanceId,
        driver: PI_PROVIDER,
        providerSessionId: input.providerSessionId,
        providerSession: sessionEntity,
        events: Stream.fromQueue(queue),
        backgroundTasksEndWithProcess: true,
        ensureThread: (ensure) => load(ensure.existingProviderThread, ensure.modelSelection),
        resumeThread: (resume) =>
          load(resume.providerThread, resume.modelSelection ?? input.modelSelection),
        injectHistory: () => Effect.succeed(false), // V2 supplies recorded portable context inline
        startTurn: (turnInput) =>
          sendPermit.withPermit(
            Effect.gen(function* () {
              if (active) return yield* protocol("Pi already has an active turn");
              yield* load(turnInput.providerThread, turnInput.modelSelection);
              const resource = session!;
              yield* Effect.tryPromise(async () => {
                const model = turnInput.modelSelection.model.trim() || options.defaultModel;
                if (model) await resource.setModel?.(model);
                const thinking =
                  getModelSelectionStringOptionValue(turnInput.modelSelection, "thinkingLevel") ??
                  options.defaultThinkingLevel;
                if (thinking) await resource.setThinkingLevel?.(thinking);
              }).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapter.ProviderAdapterTurnStartError({
                      driver: PI_PROVIDER,
                      threadId: turnInput.threadId,
                      providerThreadId: turnInput.providerThread.id,
                      runId: turnInput.runId,
                      cause,
                    }),
                ),
              );
              const images: PiImageContentLike[] = [];
              for (const attachment of turnInput.message.attachments) {
                if (attachment.type !== "image") continue;
                if (!resource.getModel?.()?.input.includes("image"))
                  return yield* protocol("The selected Pi model does not support images");
                const path = resolveAttachmentPath({
                  attachmentsDir: config.attachmentsDir,
                  attachment,
                });
                if (!path) return yield* protocol("Invalid image attachment");
                const data = yield* fs
                  .readFile(path)
                  .pipe(Effect.mapError((cause) => protocol(cause.message)));
                images.push({
                  type: "image",
                  data: Buffer.from(data).toString("base64"),
                  mimeType: attachment.mimeType,
                });
              }
              const at = yield* DateTime.now;
              const providerTurn: OrchestrationV2ProviderTurn = {
                id: ids.derive.providerTurn({
                  driver: PI_PROVIDER,
                  nativeTurnId: `${thread!.id}:${turnInput.attemptId}`,
                }),
                providerThreadId: thread!.id,
                nodeId: turnInput.rootNodeId,
                runAttemptId: turnInput.attemptId,
                nativeTurnRef: null,
                ordinal: turnInput.providerTurnOrdinal,
                status: "running",
                startedAt: at,
                completedAt: null,
              };
              active = {
                input: turnInput,
                turn: providerTurn,
                items: new Map(),
                messageIndex: 0,
                ordinal: 0,
                interrupted: false,
                requestedInterrupt: false,
                broken: false,
                initialEntryIds: new Set(resource.getBranch?.().map((entry) => entry.id)),
                settled: yield* Deferred.make<void>(),
                error: undefined,
              };
              turns.set(providerTurn.id, providerTurn);
              thread = {
                ...thread!,
                status: "active",
                firstRunOrdinal: thread!.firstRunOrdinal ?? turnInput.runOrdinal,
              };
              yield* emit({
                type: "provider_turn.updated",
                driver: PI_PROVIDER,
                threadId: input.threadId,
                providerTurn,
              });
              yield* publishThread();
              const prompt = Effect.tryPromise(() =>
                turnInput.message.text.trim() === "/compact"
                  ? (resource.compact?.() ??
                    Promise.reject(new Error("Pi compaction is unavailable")))
                  : resource.prompt(translatePiSkillToken(turnInput.message.text), { images }),
              ).pipe(
                Effect.catch((error) =>
                  Effect.gen(function* () {
                    yield* Queue.offer(inbound, {
                      type: "rove_prompt_error",
                      turnId: providerTurn.id,
                      error: error.message,
                    });
                    // A parent-owned prompt-preparation deadline cannot leave a late hook free to run tools.
                    if (resource.isStreaming || resource.isPreparingPrompt)
                      yield* disposePiResource(() => resource.abort());
                  }),
                ),
                Effect.andThen(
                  Queue.offer(inbound, { type: "rove_prompt_settled", turnId: providerTurn.id }),
                ),
                Effect.asVoid,
              );
              // Prompt completion must never hold the command worker: dialogs and Stop run concurrently.
              yield* prompt.pipe(Effect.forkIn(scope));
            }),
          ),
        compactThread: (turnInput) =>
          runtime.startTurn({ ...turnInput, message: { ...turnInput.message, text: "/compact" } }),
        steerTurn: (steer) =>
          Effect.tryPromise(() =>
            session!.prompt(translatePiSkillToken(steer.message.text), {
              streamingBehavior: "steer",
            }),
          ).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterSteerRunError({
                  driver: PI_PROVIDER,
                  providerThreadId: steer.providerThread.id,
                  providerTurnId: steer.providerTurnId,
                  cause,
                }),
            ),
          ),
        interruptTurn: (interrupt) =>
          Effect.gen(function* () {
            if (!active || active.turn.id !== interrupt.providerTurnId) return;
            const current = active;
            current.interrupted = true;
            current.requestedInterrupt = true;
            yield* Effect.tryPromise(() => session!.abort()).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: PI_PROVIDER,
                    providerThreadId: interrupt.providerThread.id,
                    providerTurnId: interrupt.providerTurnId,
                    cause,
                  }),
              ),
            );
            yield* Deferred.await(current.settled);
            // SDK Stop destroys dialog callbacks and marks the session stopped. Recover from its durable cursor next run.
            yield* disposePiResource(() => session!.dispose());
            session = undefined;
            thread = undefined;
          }),
        respondToRuntimeRequest: (response) =>
          Effect.gen(function* () {
            const pending = requests.get(response.requestId);
            if (!pending || pending.request.status !== "pending" || !session)
              return yield* protocol("Pi question is no longer respondable");
            const answered = yield* Effect.tryPromise(async () =>
              session!.respondToUserInput?.(
                pending.request.nativeRequestRef!.nativeId!,
                response.answers ?? {},
              ),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: PI_PROVIDER,
                    requestId: response.requestId,
                    cause,
                  }),
              ),
            );
            if (!answered) return yield* protocol("Pi question callback is unavailable");
            pending.request = { ...pending.request, answers: response.answers ?? {} };
          }),
        readThreadSnapshot: () =>
          Effect.gen(function* () {
            if (!thread) return yield* protocol("Pi thread is not loaded");
            yield* publishThread();
            return snapshot();
          }),
        rollbackThread: (rollback) =>
          Effect.gen(function* () {
            if (active || !session?.fork)
              return yield* protocol("Wait for Pi to settle before forking its session tree");
            let entry: string | null = null;
            if (rollback.target.type === "provider_turn") {
              const native = rollback.target.providerTurn.nativeTurnRef?.nativeId;
              const branch = session.getBranch?.() ?? [];
              const index = branch.findIndex((item) => item.id === native);
              if (index < 0)
                return yield* protocol("Pi rollback source is missing from the active branch");
              const nextUser = branch.findIndex(
                (item, i) => i > index && item.message?.role === "user",
              );
              entry =
                nextUser < 0
                  ? (session.getLeafId?.() ?? branch.at(-1)?.id ?? null)
                  : (branch[nextUser]?.parentId ?? branch[nextUser - 1]?.id ?? null);
            }
            yield* Effect.tryPromise(() => session!.fork!(entry)).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRollbackThreadError({
                    driver: PI_PROVIDER,
                    providerThreadId: rollback.providerThread.id,
                    cause,
                  }),
              ),
            );
            const retained =
              rollback.target.type === "thread_start"
                ? []
                : rollback.providerThreadTurns.filter(
                    (turn) =>
                      turn.ordinal <=
                      (rollback.target.type === "provider_turn"
                        ? rollback.target.providerTurn.ordinal
                        : 0),
                  );
            turns.clear();
            for (const turn of retained) turns.set(turn.id, turn);
            yield* publishThread();
            return snapshot();
          }),
        forkThread: () =>
          Effect.fail(
            protocol("Native cross-thread Pi fork is not available; use portable V2 context"),
          ),
      };
      return runtime;
    }),
  });
});
