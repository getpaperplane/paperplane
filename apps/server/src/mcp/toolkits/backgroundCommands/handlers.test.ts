import { assert, it } from "@effect/vitest";
import { EnvironmentId, TurnItemId } from "@getpaperplane/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as BackgroundCommandService from "../../../orchestration-v2/BackgroundCommandService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as Handlers from "./handlers.ts";
import { BackgroundCommandsToolkit } from "./tools.ts";

it.effect(
  "an external MCP client cannot execute or inspect background shell commands without a thread credential",
  () =>
    Effect.gen(function* () {
      const toolkit = yield* BackgroundCommandsToolkit;
      const start = yield* toolkit
        .handle("start_background_command", {
          clientRequestId: "outside",
          command: "echo forbidden",
        })
        .pipe(Stream.unwrap, Stream.runCollect);
      assert.equal(start[0]?.isFailure, true);
      const refusal = start[0]?.result;
      assert.ok(refusal !== undefined && "code" in refusal);
      assert.equal(refusal.code, "thread_credential_required");
      const status = yield* toolkit
        .handle("background_command_status", { itemId: TurnItemId.make("any") })
        .pipe(Stream.unwrap, Stream.runCollect);
      assert.equal(status[0]?.isFailure, true);
      const stop = yield* toolkit
        .handle("stop_background_command", { itemId: TurnItemId.make("any") })
        .pipe(Stream.unwrap, Stream.runCollect);
      assert.equal(stop[0]?.isFailure, true);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(Handlers.layer).pipe(
          Layer.provideMerge(
            Layer.mergeAll(
              McpToolAccessTestkit.liveThreadsLayer,
              Layer.mock(BackgroundCommandService.BackgroundCommandService)({}),
              Layer.succeed(McpInvocationContext.McpInvocationContext, {
                environmentId: EnvironmentId.make("environment"),
                requestNamespace: "outside",
                thread: undefined,
                client: { sessionId: "outside", label: "Outside client", access: "full-access" },
                capabilities: new Set<McpInvocationContext.McpCapability>(["orchestration"]),
                issuedAt: 1,
              }),
            ),
          ),
        ),
      ),
    ),
);
