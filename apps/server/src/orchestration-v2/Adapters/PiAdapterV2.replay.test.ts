import { assert, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ProviderReplayEntry,
  type ProviderReplayTranscript,
} from "@rove-code/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as McpProviderSessions from "@rove-code/provider-core/server/McpProviderSessions";
import * as ProviderAdapterRegistry from "../ProviderAdapterRegistry.ts";
import { PiOrchestratorReplayHarness } from "./PiAdapterV2.testkit.ts";

const transcript = (entries: ReadonlyArray<ProviderReplayEntry>): ProviderReplayTranscript => ({
  provider: ProviderDriverKind.make("pi"),
  protocol: "pi.sdk-session",
  version: "1",
  scenario: "harness-validation",
  entries,
});
const entries: ReadonlyArray<ProviderReplayEntry> = [
  { type: "expect_outbound", frame: { method: "createSession", key: 1, input: "<any>" } },
  {
    type: "emit_inbound",
    frame: {
      type: "state",
      key: 1,
      state: { sessionId: "fixture", sessionFile: "/pi-sessions/fixture.jsonl" },
    },
  },
  { type: "expect_outbound", frame: { method: "dispose", key: 1, id: 1, args: [] } },
  { type: "emit_inbound", frame: { type: "reply", key: 1, id: 1 } },
];

const load = (raw: ProviderReplayTranscript) =>
  Effect.gen(function* () {
    const decoded = yield* PiOrchestratorReplayHarness.decodeTranscript(raw);
    const registry = PiOrchestratorReplayHarness.makeProviderAdapterRegistryLayer(decoded).pipe(
      Layer.provide(McpProviderSessions.layer),
    );
    return yield* Effect.gen(function* () {
      const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const instanceId = ProviderInstanceId.make("pi");
      const adapter = yield* adapters.get(instanceId);
      const threadId = ThreadId.make("fixture");
      const modelSelection = { instanceId, model: "fixture/model" };
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: "/workspace",
      };
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("fixture"),
        modelSelection,
        runtimePolicy,
      });
      const thread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
      assert.equal(thread.nativeThreadRef?.nativeId, "/pi-sessions/fixture.jsonl");
    }).pipe(Effect.scoped, Effect.provide(registry));
  });

it.effect("loads the shipping SDK adapter and checks disposal without spawning a runtime", () =>
  load(transcript(entries)),
);

it.effect("rejects retired RPC transcripts instead of silently replaying another adapter", () =>
  Effect.gen(function* () {
    const result = yield* PiOrchestratorReplayHarness.decodeTranscript({
      ...transcript([]),
      protocol: "pi.rpc-jsonl",
    }).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(result));
  }),
);

it.effect("fails mismatched SDK calls and unconsumed transcript entries", () =>
  Effect.gen(function* () {
    for (const [raw, expected] of [
      [
        transcript([
          { type: "expect_outbound", frame: { method: "createSession", key: 2, input: "<any>" } },
        ]),
        "Pi SDK replay mismatch",
      ],
      [
        transcript([...entries, { type: "expect_outbound", frame: { method: "compact" } }]),
        "Pi SDK replay incomplete",
      ],
    ] as const) {
      const result = yield* load(raw).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) assert.include(Cause.pretty(result.cause), expected);
    }
  }),
);
