import { isDeepStrictEqual } from "node:util";
import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2ContextHandoff,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadStreamItem,
  OrchestrationV2TurnItem,
} from "@rove-code/contracts";
import {
  compactDynamicToolOutput,
  omitToolOutputImageData,
  toolOutputImages,
  toolOutputIndicatesFailure,
} from "@rove-code/shared/toolOutput";

const MAX_DETAIL_STRING_BYTES = 32_768;
const MAX_DYNAMIC_VALUE_BYTES = 16_384;
const MAX_ON_DEMAND_BYTES = 256 * 1024;

function truncateDetail(
  value: string | undefined,
  maxBytes = MAX_DETAIL_STRING_BYTES,
): string | undefined {
  if (
    value === undefined ||
    (value.length <= maxBytes && Buffer.byteLength(value, "utf8") <= maxBytes)
  ) {
    return value;
  }
  // UTF-8 needs at least one byte per UTF-16 code unit. Only encode the prefix
  // that could fit, rather than allocating a buffer for the complete output.
  const prefix = Buffer.from(value.slice(0, maxBytes), "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}\n… output truncated for transport`;
}

/**
 * Bounds the text a provider file change keeps in the event log and its
 * projection. Clients never receive more than this (see projectTurnItemForWire),
 * so a full diff of a large file would only grow the database and the heap that
 * reads it back. Agents reading the thread over MCP get the bounded text.
 */
export function boundFileChangeForStorage(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  if (item.type !== "file_change") return item;
  const { diffStr, oldStr, newStr } = item;
  const bounded = {
    ...item,
    ...(diffStr === undefined ? {} : { diffStr: truncateDetail(diffStr) }),
    ...(oldStr === undefined ? {} : { oldStr: truncateDetail(oldStr) }),
    ...(newStr === undefined ? {} : { newStr: truncateDetail(newStr) }),
  };
  return bounded.diffStr === diffStr && bounded.oldStr === oldStr && bounded.newStr === newStr
    ? item
    : bounded;
}

function summarizeDynamicValue(value: unknown): unknown {
  let serialized: string;
  try {
    if (typeof value === "string" && value.length > MAX_DYNAMIC_VALUE_BYTES) {
      serialized = value;
    } else {
      const json = JSON.stringify(value) ?? String(value);
      if (Buffer.byteLength(json, "utf8") <= MAX_DYNAMIC_VALUE_BYTES) {
        return value;
      }
      serialized = typeof value === "string" ? value : json;
    }
  } catch {
    serialized = "Unserializable tool output";
  }

  // Preserve the first nonblank normalized line, but stop after the preview.
  // Splitting and normalizing every line can allocate far more than the input.
  const start = /\S/u.exec(serialized)?.index;
  let firstLine = start === undefined ? "Large tool output" : "";
  let pendingSpace = false;
  for (let index = start ?? serialized.length; index < serialized.length; index += 1) {
    const character = serialized[index]!;
    if (character === "\n") break;
    if (/\s/u.test(character)) {
      pendingSpace = true;
      continue;
    }
    if (pendingSpace) firstLine += " ";
    firstLine += character;
    pendingSpace = false;
    if (firstLine.length > 160) break;
  }
  return {
    summary: firstLine.length <= 160 ? firstLine : `${firstLine.slice(0, 159).trimEnd()}…`,
    truncated: true,
  };
}

export function projectTurnItemForWire(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "handoff": {
      const { summary: _summary, ...projected } = item;
      return projected;
    }
    case "command_execution": {
      const { output, ...projected } = item;
      // Clients used this preview to recognize provider-reported failures. Keep
      // the outcome without retaining or serializing the output that proved it.
      const failed =
        item.outputIndicatesFailure === true ||
        (item.exitCode !== undefined && item.exitCode !== 0) ||
        (output !== undefined &&
          toolOutputIndicatesFailure(output.slice(0, MAX_DETAIL_STRING_BYTES)));
      return {
        ...projected,
        ...(failed ? { outputIndicatesFailure: true } : {}),
        ...(output?.trim() ? { outputOmitted: true } : {}),
      };
    }
    case "file_change": {
      // File identity and counts are enough for activity. Full diffs come from
      // checkpoint diffs; storage keeps only a bounded copy of this text.
      const { diffStr, oldStr: _old, newStr: _new, ...projected } = item;
      // A failed edit stores the provider's error where the diff would be.
      return item.status === "failed" && diffStr?.trim()
        ? { ...projected, diffStr: truncateDetail(diffStr) }
        : projected;
    }
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt) ?? "",
        progress: truncateDetail(item.progress),
        result: item.result === null ? null : (truncateDetail(item.result) ?? null),
      };
    case "dynamic_tool": {
      const { output: rawOutput, ...projected } = item;
      const output = compactDynamicToolOutput(rawOutput);
      return {
        ...projected,
        input: summarizeDynamicValue(item.input),
        ...(output === undefined ? {} : { output }),
        ...(hasDynamicValue(rawOutput) ? { outputOmitted: true } : {}),
      };
    }
    default:
      return item;
  }
}

function hasDynamicValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  return typeof value !== "object" || Object.keys(value).length > 0;
}

function boundDynamicValue(value: unknown): unknown {
  if (value === undefined) return value;
  if (typeof value === "string") return truncateDetail(value, MAX_ON_DEMAND_BYTES);
  let json: string;
  try {
    // Compact, so measuring does not inflate the value; clients indent it.
    json = JSON.stringify(value) ?? String(value);
  } catch {
    return "Unserializable tool value";
  }
  return Buffer.byteLength(json, "utf8") <= MAX_ON_DEMAND_BYTES
    ? value
    : truncateDetail(json, MAX_ON_DEMAND_BYTES);
}

/**
 * A tool output for a detail read, without image bytes. When the rest is too
 * large to send whole, its truncated text still comes with the image markers,
 * in order, so clients can load each image by index.
 */
function boundToolOutput(output: unknown): unknown {
  const omitted = omitToolOutputImageData(output);
  const bounded = boundDynamicValue(omitted);
  if (typeof bounded !== "string" || typeof omitted === "string") return bounded;
  const images = toolOutputImages(omitted);
  return images.length === 0
    ? bounded
    : [
        { type: "text", text: bounded },
        ...images.map((image) => ({ type: "image", mimeType: image.mimeType })),
      ];
}

/**
 * Projects one item for an on-demand detail read: keeps the input and output
 * the timeline withholds, bounded so a huge result cannot stall the socket.
 * Image bytes are left out; clients load them as `tool-output-image` assets.
 */
export function projectTurnItemForDetail(item: OrchestrationV2TurnItem): OrchestrationV2TurnItem {
  switch (item.type) {
    case "command_execution":
      return {
        ...item,
        input: truncateDetail(item.input, MAX_ON_DEMAND_BYTES) ?? "",
        output: truncateDetail(item.output, MAX_ON_DEMAND_BYTES),
      };
    case "dynamic_tool":
      return {
        ...item,
        input: boundDynamicValue(item.input),
        output: boundToolOutput(item.output),
      };
    case "subagent":
      return {
        ...item,
        prompt: truncateDetail(item.prompt, MAX_ON_DEMAND_BYTES) ?? "",
        progress: truncateDetail(item.progress, MAX_ON_DEMAND_BYTES),
        result:
          item.result === null ? null : (truncateDetail(item.result, MAX_ON_DEMAND_BYTES) ?? null),
      };
    case "handoff":
    case "file_change":
      return projectTurnItemForWire(item);
    default:
      return item;
  }
}

export function projectContextHandoffForWire(
  handoff: OrchestrationV2ContextHandoff,
): OrchestrationV2ContextHandoff {
  const { history: _history, delivery: _delivery, ...projected } = handoff;
  return { ...projected, summaryText: "" };
}

export function projectThreadProjectionForWire(
  projection: OrchestrationV2ThreadProjection,
): OrchestrationV2ThreadProjection {
  const projectedById = new Map<string, OrchestrationV2TurnItem>();
  const project = (item: OrchestrationV2TurnItem) => {
    const key = `${item.threadId}:${item.id}`;
    const existing = projectedById.get(key);
    if (existing !== undefined) return existing;
    const projected = projectTurnItemForWire(item);
    projectedById.set(key, projected);
    return projected;
  };
  return {
    ...projection,
    contextHandoffs: projection.contextHandoffs.map(projectContextHandoffForWire),
    turnItems: projection.turnItems.map(project),
    visibleTurnItems: projection.visibleTurnItems.map((row) => ({
      ...row,
      item: project(row.item),
    })),
  };
}

type LiveEvent = Extract<OrchestrationV2ThreadStreamItem, { kind: "event" }>;
type StreamingTextEvent = Extract<
  OrchestrationV2DomainEvent,
  { type: "message.updated" | "turn-item.updated" }
>;

/**
 * One projector per live subscription, AFTER coalescing and never on replay.
 * Only updatedAt may differ besides text; any other change gets a full event.
 * Bound retained baselines independently of the live queue's payload budget.
 */
export function makeThreadLiveTextProjector(acceptTextAppends: boolean) {
  const previous = new Map<string, StreamingTextEvent["payload"]>();
  const maxCodeUnits = 1_048_576;
  let retainedCodeUnits = 0;
  const forget = (key: string) => {
    const value = previous.get(key);
    if (value !== undefined && "text" in value) retainedCodeUnits -= value.text.length;
    previous.delete(key);
  };
  return (item: LiveEvent): OrchestrationV2ThreadStreamItem => {
    if (!acceptTextAppends) return item;
    const event = item.event;
    if (event.type !== "message.updated" && event.type !== "turn-item.updated") return item;
    const payload = event.payload;
    const key = `${event.threadId}:${event.type}:${payload.id}`;
    const baseline = previous.get(key);
    forget(key);
    if (
      !("text" in payload) ||
      !("streaming" in payload) ||
      !payload.streaming ||
      ("role" in payload
        ? payload.role !== "assistant"
        : (payload.type !== "assistant_message" && payload.type !== "reasoning") ||
          payload.status !== "running") ||
      payload.text.length > maxCodeUnits
    )
      return item;

    while (previous.size >= 128 || retainedCodeUnits + payload.text.length > maxCodeUnits) {
      const oldest = previous.keys().next().value;
      if (oldest === undefined) break;
      forget(oldest);
    }
    previous.set(key, payload);
    retainedCodeUnits += payload.text.length;
    if (
      baseline === undefined ||
      !("text" in baseline) ||
      payload.text.length <= baseline.text.length ||
      !payload.text.startsWith(baseline.text)
    )
      return item;

    // Compare metadata only: never stringify or deep-compare the growing text.
    const { text: _oldText, updatedAt: _oldUpdatedAt, ...oldFields } = baseline;
    const { text: _text, updatedAt: _updatedAt, ...fields } = payload;
    if (!isDeepStrictEqual(oldFields, fields)) return item;
    return {
      kind: "text-append",
      sequence: item.sequence,
      threadId: event.threadId,
      entity:
        event.type === "message.updated"
          ? { type: "message", id: event.payload.id }
          : { type: "turn-item", id: event.payload.id },
      offset: baseline.text.length,
      append: payload.text.slice(baseline.text.length),
      updatedAt: payload.updatedAt,
      occurredAt: event.occurredAt,
    };
  };
}

export function projectDomainEventForWire(
  event: OrchestrationV2DomainEvent,
): OrchestrationV2DomainEvent {
  return event.type === "turn-item.updated"
    ? { ...event, payload: projectTurnItemForWire(event.payload) }
    : event.type === "context-handoff.updated"
      ? { ...event, payload: projectContextHandoffForWire(event.payload) }
      : event;
}
