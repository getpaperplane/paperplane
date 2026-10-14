import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
} from "@rove-code/contracts";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-08-30T12:00:00.000Z";
const THREAD_ID = ThreadId.make("poteto-retention-thread");

function baseEvent(
  sequence: number,
  commandId: CommandId,
): Omit<OrchestrationEvent, "type" | "payload"> {
  return {
    sequence,
    eventId: EventId.make(`poteto-retention-event-${sequence}`),
    aggregateKind: "thread",
    aggregateId: THREAD_ID,
    occurredAt: NOW,
    commandId,
    causationEventId: null,
    correlationId: commandId,
    metadata: {},
  };
}

it.effect("retains the complete latest Poteto run chain outside the recent activity window", () =>
  Effect.gen(function* () {
    let model = yield* projectEvent(createEmptyReadModel(NOW), {
      ...baseEvent(1, CommandId.make("thread-create")),
      type: "thread.created",
      payload: {
        threadId: THREAD_ID,
        projectId: ProjectId.make("project-1"),
        title: "Pilot",
        modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "test/model" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    });
    const progress = {
      runId: "poteto-run",
      attemptId: "poteto-attempt",
      status: "running",
      phase: "implement",
      reason: null,
    };
    const append = (sequence: number, kind: string, payload: unknown): OrchestrationEvent => ({
      ...baseEvent(sequence, CommandId.make(`poteto-retention-${sequence}`)),
      type: "thread.activity-appended",
      payload: {
        threadId: THREAD_ID,
        activity: {
          id: EventId.make(`poteto-retention-activity-${sequence}`),
          kind,
          summary: kind,
          tone: "info",
          turnId: null,
          createdAt: NOW,
          payload,
        },
      },
    });
    model = yield* projectEvent(
      model,
      append(2, "poteto.requested", {
        runId: "poteto-run",
        attemptId: "poteto-attempt",
        progress,
      }),
    );
    model = yield* projectEvent(
      model,
      append(3, "poteto.event", {
        runId: "poteto-run",
        attemptId: "poteto-attempt",
        event: { type: "accepted", phase: "implement", result: { report: "private" } },
        progress,
      }),
    );
    for (let sequence = 4; sequence <= 504; sequence += 1) {
      model = yield* projectEvent(
        model,
        append(sequence, "tool.completed", { itemType: "command_execution" }),
      );
    }

    const activities = model.threads[0]!.activities;
    expect(activities).toHaveLength(502);
    expect(activities.slice(0, 2).map((activity) => activity.kind)).toEqual([
      "poteto.requested",
      "poteto.event",
    ]);
    expect(activities.at(-1)?.id).toBe(EventId.make("poteto-retention-activity-504"));
  }),
);
