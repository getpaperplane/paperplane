import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, RunId, ThreadId } from "@rove-code/contracts";

import { derive } from "./IdAllocator.ts";

const namespace = { idDerivationVersion: 2 as const };
const commandId = CommandId.make("command:mcp:session%3Aone:delegate-task:call%3Aone");

it("keeps missing-version app-owned ids byte-identical to legacy derivation", () => {
  const command = { commandId };
  const escaped = encodeURIComponent(commandId);
  assert.equal(derive.delegatedTaskNode(command), `node:delegated-task:${escaped}`);
  assert.equal(derive.delegatedTaskThread(command), `thread:delegated-task:${escaped}`);
  assert.equal(derive.delegatedTaskMessage(command), `message:delegated-task:${escaped}`);
  assert.equal(derive.delegatedTaskTurnItem(command), `turn-item:delegated-task:${escaped}`);
  assert.equal(derive.createdThreadTurnItem(command), `turn-item:created-thread:${escaped}`);
  const threadId = ThreadId.make("thread:a%3Ab:c");
  const runId = derive.run({ threadId, ordinal: 3 });
  assert.equal(runId, "run:thread:thread%3Aa%253Ab%3Ac:ordinal:3");
  assert.equal(
    derive.runAttempt({ runId, attemptOrdinal: 2 }),
    `run-attempt:run:${encodeURIComponent(runId)}:attempt:2`,
  );
  assert.equal(derive.rootNode({ runId }), `node:run:${encodeURIComponent(runId)}:root`);
  assert.equal(
    derive.rootNodeAttempt({ runId, attemptOrdinal: 2 }),
    `node:run:${encodeURIComponent(runId)}:attempt:2:root`,
  );
  const messageId = MessageId.make("message:a%3Ab:c");
  assert.equal(derive.userTurnItem({ messageId }), "turn-item:message:message%3Aa%253Ab%3Ac");
  assert.equal(
    derive.delegatedTaskThread({ commandId, idDerivationVersion: undefined }),
    derive.delegatedTaskThread(command),
  );
});

it("is deterministic, domain separated and retains semantic prefixes", () => {
  const input = { ...namespace, commandId };
  const outputs = [
    ["node:delegated-task:", derive.delegatedTaskNode(input)],
    ["thread:delegated-task:", derive.delegatedTaskThread(input)],
    ["message:delegated-task:", derive.delegatedTaskMessage(input)],
    ["turn-item:delegated-task:", derive.delegatedTaskTurnItem(input)],
    ["turn-item:created-thread:", derive.createdThreadTurnItem(input)],
  ];
  for (const [prefix, id] of outputs) {
    assert.ok(id!.startsWith(`${prefix}v2:`));
    assert.match(id!.slice(prefix!.length + 3), /^[A-Za-z0-9_-]{43}$/);
  }
  assert.equal(new Set(outputs.map(([, id]) => id)).size, outputs.length);
  assert.equal(derive.delegatedTaskThread(input), derive.delegatedTaskThread({ ...input }));
  assert.equal(
    derive.delegatedTaskThread(input),
    "thread:delegated-task:v2:cVnAwcvfSbHqRCqXzOF_TwIRr6Dx8cyW1LtrxV5OXGg",
  );
  const runId = RunId.make("run:one");
  assert.notEqual(
    derive.rootNode({ ...namespace, runId }),
    derive.rootNodeAttempt({ ...namespace, runId, attemptOrdinal: 1 }),
  );
  assert.notEqual(
    derive.runAttempt({ ...namespace, runId, attemptOrdinal: 1 }),
    derive.runAttempt({ ...namespace, runId, attemptOrdinal: 2 }),
  );
});

it("does not conflate encoded parts, delimiters, empty strings or Unicode", () => {
  const inputs = [
    "a:b",
    "a%3Ab",
    "a:b:c",
    "a%3Ab:c",
    "",
    "%",
    "é",
    "e\u0301",
    "\ud800",
    "�",
    "a\u0000b",
    '["a","b"]',
  ];
  const outputs = inputs.map((value) =>
    derive.delegatedTaskThread({ ...namespace, commandId: CommandId.make(`command:${value}`) }),
  );
  assert.equal(new Set(outputs).size, inputs.length);
  const runs = [
    derive.run({ ...namespace, threadId: ThreadId.make("a:ordinal:1"), ordinal: 2 }),
    derive.run({ ...namespace, threadId: ThreadId.make("a"), ordinal: 12 }),
    derive.run({ ...namespace, threadId: ThreadId.make("a%3Aordinal%3A1"), ordinal: 2 }),
  ];
  assert.equal(new Set(runs).size, runs.length);
});

it("bounds every opted-in entity through 12 nested delegated tasks", () => {
  let threadId = ThreadId.make("thread:root");
  for (let depth = 1; depth <= 12; depth++) {
    const runId = derive.run({ ...namespace, threadId, ordinal: depth });
    const command = {
      ...namespace,
      commandId: CommandId.make(
        `command:mcp:${encodeURIComponent(threadId)}:${encodeURIComponent(runId)}:delegate-task:${depth}`,
      ),
    };
    const messageId = derive.delegatedTaskMessage(command);
    threadId = derive.delegatedTaskThread(command);
    const ids = [
      threadId,
      runId,
      messageId,
      derive.delegatedTaskNode(command),
      derive.delegatedTaskTurnItem(command),
      derive.createdThreadTurnItem(command),
      derive.userTurnItem({ ...namespace, messageId }),
      derive.runAttempt({ ...namespace, runId, attemptOrdinal: depth }),
      derive.rootNode({ ...namespace, runId }),
      derive.rootNodeAttempt({ ...namespace, runId, attemptOrdinal: depth }),
    ];
    for (const id of ids) assert.isAtMost(id.length, 72);
  }
  const huge = { ...namespace, commandId: CommandId.make("%:嵌套".repeat(10000)) };
  assert.equal(derive.delegatedTaskTurnItem(huge).length, 71);
});
