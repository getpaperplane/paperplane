// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Runs inside the Pi runtime worker, outside the Effect runtime.
/**
 * Rove-owned Pi subagents (ADR 0003).
 *
 * Pi has no subagent API, so Rove gives Pi threads its own `subagent` tool. Each
 * call runs a fresh, extension-free Pi session in the runtime worker. Because
 * Rove starts the session, it knows exactly when the agent starts, what it
 * does, and how it ends: rows come from that lifecycle, never from guessing at
 * processes. Agents that third-party extensions start are ordinary tool calls.
 *
 * Transcripts remain JSONL under `<root>/<threadId>/<agentId>.jsonl`.
 * V2 observes their child-node lifecycle; transcript inspection needs a separate authorized query.
 *
 * @module provider/Layers/PiSubagents
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  RuntimeTaskId,
  type PiThinkingLevel,
  type RuntimeTaskUsage,
  type TaskCompletedPayload,
  type TaskProgressPayload,
  type TaskStartedPayload,
  type TaskUpdatedPayload,
} from "@rove-code/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** Environment variable naming the transcript root for the Pi runtime worker. */
export const PI_SUBAGENT_TRANSCRIPTS_ENV = "ROVE_AGENT_TRANSCRIPTS";

// Prefixed so it cannot collide with a third-party extension's `subagent` tool.
const PI_SUBAGENT_TOOL_NAME = "rove_subagent";

/** Appended to a subagent's system prompt in place of the thread's runtime instructions. */
export const PI_SUBAGENT_INSTRUCTIONS = `<subagent>
You are a subagent started by another agent in Rove Code. Nobody can answer your questions, so work autonomously with the tools you have. When you finish, reply with a concise report of what you found or changed: that final message is returned to the agent that started you.
</subagent>`;

export type PiAgentTaskDescriptor =
  | { readonly type: "task.started"; readonly payload: TaskStartedPayload }
  | { readonly type: "task.progress"; readonly payload: TaskProgressPayload }
  | { readonly type: "task.updated"; readonly payload: TaskUpdatedPayload }
  | { readonly type: "task.completed"; readonly payload: TaskCompletedPayload };

/**
 * One transcript line. Older transcripts also carry kinds and fields from the
 * removed process observer (`exit`, `cmd`, ...); the reader still accepts them.
 */
export interface PiAgentEntry {
  readonly v: 1;
  /** Agent id; also the Agents row's task id. */
  readonly a: string;
  readonly th: string;
  /** Writer pid and per-writer sequence. */
  readonly w: number;
  readonly q: number;
  readonly at: number;
  readonly k:
    | "start"
    | "meta"
    | "task"
    | "user"
    | "text"
    | "tool"
    | "toolEnd"
    | "usage"
    | "busy"
    | "idle"
    | "exit";
  readonly cwd?: string;
  readonly cmd?: string;
  readonly model?: string;
  readonly thinking?: string;
  readonly session?: string;
  readonly text?: string;
  readonly stop?: string;
  readonly error?: string;
  readonly id?: string;
  readonly name?: string;
  readonly target?: string;
  readonly isError?: boolean;
  readonly out?: string;
  readonly in?: number;
  readonly outTok?: number;
  readonly cr?: number;
  readonly cw?: number;
  readonly cost?: number;
  readonly cum?: boolean;
  readonly code?: number | null;
  readonly signal?: string | null;
  readonly trunc?: boolean;
}

type AnyRecord = Record<string, unknown>;

/** The slice of an SDK `AgentSession` a subagent run needs. */
export interface PiSubagentSession {
  subscribe(listener: (event: { readonly type: string } & AnyRecord) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  dispose(): void | Promise<void>;
  getLastAssistantText(): string | undefined;
}

interface PiSubagentToolOptions {
  readonly threadId: string;
  /** Transcript root; unset keeps rows without a transcript. */
  readonly transcriptsRoot: string | undefined;
  readonly emit: (task: PiAgentTaskDescriptor) => void;
  /** Starts the child session; the model and thinking level default to the caller's. */
  readonly startSession: (parent: {
    readonly model: unknown;
    readonly thinkingLevel: string | undefined;
  }) => Promise<{
    readonly session: PiSubagentSession;
    readonly model: string | undefined;
    /** Effective SDK selection, after clamping to the child model. */
    readonly thinkingLevel?: PiThinkingLevel | undefined;
  }>;
  readonly progressIntervalMs?: number;
}

const Input = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  prompt: Schema.String.check(Schema.isNonEmpty()),
});
const decodeInput = Schema.decodeUnknownSync(Input);

// The child's SDK events, parsed to the fields Rove reports.
const decodeAssistantMessage = Schema.decodeUnknownOption(
  Schema.Struct({
    role: Schema.Literal("assistant"),
    content: Schema.optional(Schema.Unknown),
    stopReason: Schema.optional(Schema.String),
    errorMessage: Schema.optional(Schema.String),
    provider: Schema.optional(Schema.String),
    model: Schema.optional(Schema.String),
    usage: Schema.optional(
      Schema.Struct({
        input: Schema.optional(Schema.Number),
        output: Schema.optional(Schema.Number),
        cacheRead: Schema.optional(Schema.Number),
        cacheWrite: Schema.optional(Schema.Number),
        cost: Schema.optional(Schema.Struct({ total: Schema.optional(Schema.Number) })),
      }),
    ),
  }),
);
const decodeToolStart = Schema.decodeUnknownOption(
  Schema.Struct({
    toolCallId: Schema.String,
    toolName: Schema.String,
    args: Schema.optional(Schema.Unknown),
  }),
);
const decodeToolEnd = Schema.decodeUnknownOption(
  Schema.Struct({
    toolCallId: Schema.String,
    isError: Schema.optional(Schema.Boolean),
    result: Schema.optional(Schema.Unknown),
  }),
);

const TITLE_LIMIT = 100;
const SUMMARY_LIMIT = 180;
const TEXT_LIMIT = 16_384;
const OUTPUT_LIMIT = 4_096;
const PARTIAL_TEXT_LIMIT = 2_000;
const PARTIAL_FILES_LIMIT = 50;

// Pi's standard tools that change files; their `path` argument names the file.
const FILE_CHANGING_TOOLS = new Set(["edit", "write"]);
const decodeFileArgs = Schema.decodeUnknownOption(
  Schema.Struct({ path: Schema.optional(Schema.String) }),
);

/**
 * What a stopped or failed child got done, so the parent can resume from it
 * instead of repeating the work. The message becomes the tool call's result.
 */
function unfinishedResult(
  headline: string,
  progress: { readonly lastText: string | undefined; readonly changedFiles: Set<string> },
): string {
  const parts = [headline];
  if (progress.lastText) {
    const text = progress.lastText.trim();
    parts.push(
      `Its last message:\n${text.length <= PARTIAL_TEXT_LIMIT ? text : `${text.slice(0, PARTIAL_TEXT_LIMIT)}…`}`,
    );
  }
  if (progress.changedFiles.size > 0) {
    const files = [...progress.changedFiles];
    const listed = files.slice(0, PARTIAL_FILES_LIMIT).map((file) => `- ${file}`);
    if (files.length > PARTIAL_FILES_LIMIT)
      listed.push(`- …and ${files.length - PARTIAL_FILES_LIMIT} more`);
    parts.push(
      `Files it changed (they may be partly edited; check them before redoing the work):\n${listed.join("\n")}`,
    );
  }
  return parts.join("\n\n");
}

const safeSegment = (value: string) => value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 200);

function firstLine(value: string, limit: number): string {
  const line =
    value
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0 && !/^(`{3,}|~{3,})[\w-]*$/.test(part)) ?? "";
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`;
}

function messageText(message: unknown): string {
  const content = (message as AnyRecord | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) =>
      (part as AnyRecord)?.type === "text" && typeof (part as AnyRecord).text === "string"
        ? [(part as AnyRecord).text as string]
        : [],
    )
    .join("\n");
}

/** The argument that says what a tool call is about, for one-line activity. */
function toolTarget(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as AnyRecord;
  for (const key of ["path", "file_path", "command", "pattern", "url", "query"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return firstLine(value, 160);
  }
  return undefined;
}

/** Appends entries for one agent; transcript failures never fail the agent. */
function transcriptWriter(root: string | undefined, threadId: string, agentId: string) {
  let sequence = 0;
  let file: string | undefined;
  if (root) {
    try {
      const directory = NodePath.join(root, safeSegment(threadId));
      NodeFS.mkdirSync(directory, { recursive: true });
      file = NodePath.join(directory, `${safeSegment(agentId)}.jsonl`);
    } catch {
      file = undefined;
    }
  }
  return (kind: PiAgentEntry["k"], fields?: Omit<Partial<PiAgentEntry>, "v" | "a" | "th">) => {
    if (!file) return;
    const entry: PiAgentEntry = {
      v: 1,
      a: agentId,
      th: threadId,
      w: process.pid,
      q: sequence++,
      at: Date.now(),
      k: kind,
      ...fields,
    };
    try {
      NodeFS.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } catch {
      // A full disk costs the transcript, not the run.
    }
  };
}

/**
 * Tracks children so a thread session can stop them on disposal; the SDK aborts
 * a running tool's signal on Stop, but disposal must not wait for a tool to notice.
 */
export function createPiSubagentTool(options: PiSubagentToolOptions) {
  const running = new Set<PiSubagentSession>();
  const progressIntervalMs = options.progressIntervalMs ?? 750;

  const tool: ToolDefinition = {
    name: PI_SUBAGENT_TOOL_NAME,
    label: "Subagent",
    description:
      "Delegate a self-contained task to a subagent. It works in the same workspace with its own fresh context and the standard tools, then returns its final report. The subagent cannot see this conversation, so put everything it needs in the prompt. Use it for independent research or work that would flood your context; call it several times in one response to run subagents in parallel. Do not delegate what you can finish in a few tool calls: a subagent starts cold, without your context, and pays for its own setup.",
    promptSnippet: "Delegate a self-contained task to a subagent with its own context",
    parameters: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "A short (3-6 word) title for the task, shown to the user.",
        },
        prompt: {
          type: "string",
          description: "The complete task for the subagent, including any context it needs.",
        },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
    execute: async (toolCallId, rawInput, signal, _onUpdate, ctx) => {
      const input = decodeInput(rawInput);
      signal?.throwIfAborted();
      const agentId = NodeCrypto.randomUUID();
      const write = transcriptWriter(options.transcriptsRoot, options.threadId, agentId);
      const title = firstLine(input.description?.trim() || input.prompt, TITLE_LIMIT);
      const state = {
        model: undefined as string | undefined,
        thinking: ctx.thinkingLevel,
        lastText: undefined as string | undefined,
        lastError: undefined as string | undefined,
        lastStop: undefined as string | undefined,
        lastTool: undefined as string | undefined,
        openTools: new Map<string, string>(),
        /** Paths that file-changing tools were called with, keyed by call until they succeed. */
        pendingFiles: new Map<string, string>(),
        changedFiles: new Set<string>(),
        toolCount: 0,
        usage: { in: 0, out: 0, cr: 0, cw: 0 },
      };

      const typedUsage = (): RuntimeTaskUsage | undefined => {
        const { usage } = state;
        const total = usage.in + usage.out + usage.cr + usage.cw;
        if (total === 0 && state.toolCount === 0) return undefined;
        return {
          totalTokens: total,
          ...(usage.in > 0 ? { inputTokens: usage.in } : undefined),
          ...(usage.cr > 0 ? { cachedInputTokens: usage.cr } : undefined),
          ...(usage.out > 0 ? { outputTokens: usage.out } : undefined),
          ...(state.toolCount > 0 ? { toolUses: state.toolCount } : undefined),
        };
      };
      const linkage = () => {
        const usage = typedUsage();
        return {
          taskId: RuntimeTaskId.make(agentId),
          taskType: "subagent",
          title,
          ...(state.model ? { model: state.model } : undefined),
          ...(state.thinking ? { effort: state.thinking } : undefined),
          toolUseId: toolCallId,
          ...(usage ? { typedUsage: usage } : undefined),
        } as const;
      };

      let progressTimer: ReturnType<typeof setTimeout> | undefined;
      let lastProgressAt = 0;
      let settled = false;
      const emitProgress = () => {
        progressTimer = undefined;
        if (settled) return;
        lastProgressAt = Date.now();
        const open = [...state.openTools.values()].at(-1);
        const activity = open ?? (state.lastText ? firstLine(state.lastText, SUMMARY_LIMIT) : "");
        options.emit({
          type: "task.progress",
          payload: {
            ...linkage(),
            description: title,
            status: "running",
            ...(activity ? { summary: activity.slice(0, SUMMARY_LIMIT) } : undefined),
            ...(state.lastTool ? { lastToolName: state.lastTool } : undefined),
          },
        });
      };
      const queueProgress = () => {
        if (settled || progressTimer) return;
        progressTimer = setTimeout(
          emitProgress,
          Math.max(0, lastProgressAt + progressIntervalMs - Date.now()),
        );
        progressTimer.unref?.();
      };

      write("start", { cwd: ctx.cwd });
      write("task", { text: input.prompt.slice(0, TEXT_LIMIT) });
      const { typedUsage: _usage, ...started } = linkage();
      options.emit({ type: "task.started", payload: { ...started, description: title } });

      const settle = (status: TaskCompletedPayload["status"], summary: string | undefined) => {
        if (settled) return;
        settled = true;
        if (progressTimer) clearTimeout(progressTimer);
        options.emit({
          type: "task.completed",
          payload: {
            ...linkage(),
            status,
            ...(summary ? { summary: firstLine(summary, SUMMARY_LIMIT) } : undefined),
          },
        });
      };

      let session: PiSubagentSession | undefined;
      try {
        const child = await options.startSession({
          model: ctx.model,
          thinkingLevel: ctx.thinkingLevel,
        });
        session = child.session;
        running.add(session);
        state.model = child.model;
        state.thinking = child.thinkingLevel ?? ctx.thinkingLevel;
        write("meta", {
          ...(state.model ? { model: state.model } : undefined),
          ...(state.thinking ? { thinking: state.thinking } : undefined),
        });
        session.subscribe((event) => {
          switch (event.type) {
            case "message_end": {
              const message = decodeAssistantMessage(event.message);
              if (Option.isNone(message)) return;
              const { stopReason, errorMessage, provider, usage } = message.value;
              const text = messageText(message.value).trim();
              if (text) state.lastText = text;
              if (stopReason) state.lastStop = stopReason;
              if (errorMessage) state.lastError = errorMessage;
              const model =
                provider && message.value.model ? `${provider}/${message.value.model}` : undefined;
              if (model) state.model = model;
              write("text", {
                ...(text ? { text: text.slice(0, TEXT_LIMIT) } : undefined),
                ...(stopReason ? { stop: stopReason } : undefined),
                ...(errorMessage ? { error: errorMessage.slice(0, 1_000) } : undefined),
                ...(model ? { model } : undefined),
              });
              if (usage) {
                const tokens = {
                  in: usage.input ?? 0,
                  outTok: usage.output ?? 0,
                  cr: usage.cacheRead ?? 0,
                  cw: usage.cacheWrite ?? 0,
                };
                state.usage.in += tokens.in;
                state.usage.out += tokens.outTok;
                state.usage.cr += tokens.cr;
                state.usage.cw += tokens.cw;
                const cost = usage.cost?.total ?? 0;
                write("usage", { ...tokens, ...(cost > 0 ? { cost } : undefined) });
              }
              break;
            }
            case "tool_execution_start": {
              const tool = decodeToolStart(event);
              if (Option.isNone(tool)) return;
              const { toolCallId: id, toolName: name } = tool.value;
              const target = toolTarget(tool.value.args);
              state.toolCount += 1;
              state.lastTool = name;
              state.openTools.set(id, `▸ ${name}${target ? ` ${target}` : ""}`);
              const path = FILE_CHANGING_TOOLS.has(name)
                ? Option.getOrUndefined(decodeFileArgs(tool.value.args))?.path?.trim()
                : undefined;
              if (path) state.pendingFiles.set(id, path);
              write("tool", { id, name, ...(target ? { target } : undefined) });
              break;
            }
            case "tool_execution_end": {
              const tool = decodeToolEnd(event);
              if (Option.isNone(tool)) return;
              const id = tool.value.toolCallId;
              state.openTools.delete(id);
              const changed = state.pendingFiles.get(id);
              state.pendingFiles.delete(id);
              if (changed && !tool.value.isError) state.changedFiles.add(changed);
              const out = messageText(tool.value.result).trim();
              write("toolEnd", {
                id,
                ...(tool.value.isError ? { isError: true } : undefined),
                ...(out ? { out: out.slice(0, OUTPUT_LIMIT) } : undefined),
              });
              break;
            }
            default:
              return;
          }
          queueProgress();
        });

        const stop = () => void session?.abort();
        signal?.addEventListener("abort", stop, { once: true });
        try {
          if (signal?.aborted) throw new Error("Subagent was stopped.");
          await session.prompt(input.prompt);
        } finally {
          signal?.removeEventListener("abort", stop);
        }
      } catch (error) {
        if (signal?.aborted) state.lastStop = "aborted";
        else if (!state.lastError) {
          state.lastError = error instanceof Error ? error.message : String(error);
          write("text", { error: state.lastError.slice(0, 1_000) });
        }
      } finally {
        if (session) {
          running.delete(session);
          try {
            await session.dispose();
          } catch {
            // Disposal failures must not hide the run's outcome.
          }
        }
      }

      const report = session?.getLastAssistantText()?.trim() || state.lastText;
      if (state.lastStop === "aborted" || signal?.aborted) {
        settle("stopped", "Stopped");
        throw new Error(unfinishedResult("Subagent was stopped.", state));
      }
      if (state.lastStop === "error" || state.lastError) {
        const error = state.lastError ?? "Subagent failed.";
        settle("failed", error);
        throw new Error(unfinishedResult(error, state));
      }
      settle("completed", report);
      return {
        content: [
          { type: "text" as const, text: report || "The subagent finished without a report." },
        ],
        details: { agentId },
      };
    },
  };

  return {
    tool,
    /** Stops every running child; their tool calls then settle as stopped. */
    dispose: async () => {
      await Promise.allSettled([...running].map((session) => session.abort()));
    },
  };
}
