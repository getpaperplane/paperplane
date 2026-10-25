import type { AgentSession } from "@earendil-works/pi-coding-agent";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  codexUsageLimitFromStreamEvent,
  mergeUsageLimits,
  usageLimitFromErrorPayload,
  usageLimitFromHttpError,
  type CodexUsageLimitWindows,
} from "../usageLimitError.ts";
import type { UsageLimitStatus } from "../usageLimitStatus.ts";

type PiStreamModel = Parameters<AgentSession["agent"]["streamFunction"]>[0];
export interface PiUsageLimitEvidence {
  readonly model: PiStreamModel;
  readonly status: UsageLimitStatus;
}
const decodeEventType = Schema.decodeUnknownOption(Schema.Struct({ type: Schema.String }));

/** Each SDK request owns its evidence, including retries and virtual-model routing. */
export function createPiUsageLimitCapture() {
  let last: PiUsageLimitEvidence | null = null;
  const now = () => DateTime.formatIso(DateTime.nowUnsafe());
  const observe = (agent: Pick<AgentSession["agent"], "streamFunction">) => {
    const stream = agent.streamFunction;
    agent.streamFunction = (model, context, options) => {
      const request: { model: PiStreamModel; status: UsageLimitStatus } = {
        model,
        status: { type: "unavailable" },
      };
      last = request;
      const windows = new Map<string, UsageLimitStatus>();
      const snapshots = new Map<string, CodexUsageLimitWindows>();
      const useModel = (actualModel: PiStreamModel) => {
        if (
          request.model.id !== actualModel.id ||
          request.model.provider !== actualModel.provider
        ) {
          windows.clear();
          snapshots.clear();
          request.status = { type: "unavailable" };
        }
        request.model = actualModel;
      };
      const send = options?.fetch ?? globalThis.fetch;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        request.status = { type: "unavailable" };
        windows.clear();
        snapshots.clear();
        const response = await send(input, init);
        request.status = { type: "available" };
        if (response.status === 429) {
          const body: unknown = await response
            .clone()
            .json()
            .catch(() => null);
          const limit = usageLimitFromHttpError(response.headers, body, now());
          request.status = limit
            ? { type: "limited", resetAt: limit.resetAt }
            : { type: "unavailable" };
        }
        return response;
      };
      return stream(model, context, {
        ...options,
        fetch,
        onPayload: (payload, actualModel) => {
          useModel(actualModel);
          return options?.onPayload?.(payload, actualModel);
        },
        onProviderStreamEvent: async (data, actualModel) => {
          useModel(actualModel);
          const observedAt = now();
          const update = codexUsageLimitFromStreamEvent(data, observedAt, snapshots);
          if (update) {
            snapshots.set(update.id, update.windows);
            windows.set(update.id, update.status);
          }
          const event = decodeEventType(data);
          if (Option.isSome(event)) {
            switch (event.value.type) {
              case "error":
              case "response.failed": {
                const limit = usageLimitFromErrorPayload(data, observedAt);
                const blocking = [...windows.values()].flatMap((status) =>
                  status.type === "limited" ? [{ resetAt: status.resetAt }] : [],
                );
                const combined = limit
                  ? mergeUsageLimits([
                      ...blocking,
                      ...(limit.resetAt !== null || blocking.length === 0 ? [limit] : []),
                    ])
                  : null;
                request.status = combined
                  ? { type: "limited", resetAt: combined.resetAt }
                  : { type: "available" };
                break;
              }
              case "response.completed":
              case "response.done":
              case "message_stop":
                request.status = { type: "available" };
                break;
            }
          }
          await options?.onProviderStreamEvent?.(data, actualModel);
        },
      });
    };
  };
  const take = () => {
    const value = last;
    last = null;
    return value;
  };
  return { observe, take };
}
