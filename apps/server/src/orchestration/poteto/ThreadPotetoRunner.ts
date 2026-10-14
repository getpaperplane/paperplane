// @effect-diagnostics nodeBuiltinImport:off - Candidate artifacts live outside the working checkout.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { PotetoProgress, ThreadId } from "@rove-code/contracts";
import { getModelSelectionStringOptionValue } from "@rove-code/shared/model";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ServerConfig } from "../../config.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { PI_THINKING_DESCRIPTOR_ID } from "../../provider/Layers/PiProvider.ts";
import {
  createPotetoMode,
  decodePotetoEvents,
  potetoRevision,
  replayPotetoMode,
  runPotetoMode,
  type PotetoJournal,
} from "./PotetoMode.ts";
import {
  assertPotetoProjectJournal,
  exportPotetoProjectPatch,
  preparePotetoProjectPilot,
  readPotetoProjectMetadata,
} from "./PotetoProjectPilot.ts";
import { createPotetoProjectProbe, resolvePotetoImage } from "./PotetoProjectRunner.ts";
import type { ThreadPotetoRun } from "./ThreadPotetoState.ts";

export interface ThreadPotetoRunnerInput {
  readonly threadId: ThreadId;
  readonly run: ThreadPotetoRun;
  readonly workspace: string;
  readonly journal: PotetoJournal;
  readonly signal: AbortSignal;
}
export class ThreadPotetoRunner extends Context.Service<
  ThreadPotetoRunner,
  {
    readonly run: (input: ThreadPotetoRunnerInput) => Promise<PotetoProgress>;
    readonly recoverCandidate: (
      input: Pick<ThreadPotetoRunnerInput, "threadId" | "run">,
    ) => Promise<PotetoProgress>;
  }
>()("@rove-code/server/orchestration/poteto/ThreadPotetoRunner") {}

function runDirectory(stateDir: string, threadId: ThreadId, runId: string) {
  const key = NodeCrypto.createHash("sha256")
    .update(JSON.stringify([threadId, runId]))
    .digest("hex");
  return NodePath.join(stateDir, "poteto", key);
}

/** Rebuilds a completed candidate artifact without Docker, provider lookup, or inference. */
export function recoverThreadPotetoCandidate(
  stateDir: string,
  input: Pick<ThreadPotetoRunnerInput, "threadId" | "run">,
): PotetoProgress {
  const directory = runDirectory(stateDir, input.threadId, input.run.runId);
  const metadata = readPotetoProjectMetadata(directory);
  const events = decodePotetoEvents(input.run.events);
  assertPotetoProjectJournal(metadata, events);
  const state = replayPotetoMode(events);
  const path = exportPotetoProjectPatch(directory, metadata, state);
  const patch = NodeFS.readFileSync(path, "utf8");
  const progress: PotetoProgress = {
    runId: input.run.runId,
    attemptId: input.run.attemptId,
    status: "candidate-ready",
    phase: null,
    reason: null,
    baseCommit: metadata.commit,
    revision: potetoRevision(state.files),
  };
  // Never present a truncated diff as an applicable patch.
  return patch.length <= 32_768
    ? { ...progress, patch }
    : {
        ...progress,
        reason: `Candidate patch exceeds the inline preview limit. Full patch saved on the host: ${path}`,
      };
}

/** All control state is in the main event log; only pinned snapshots/check output/patches live here. */
export const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const instances = yield* ProviderInstanceRegistry;
  const context = yield* Effect.context<ProviderInstanceRegistry>();
  const runPromise = Effect.runPromiseWith(context);
  return ThreadPotetoRunner.of({
    recoverCandidate: async (input) => recoverThreadPotetoCandidate(stateDir, input),
    run: async ({ threadId, run, workspace, journal, signal }) => {
      signal.throwIfAborted();
      const instance = await runPromise(instances.getInstance(run.modelSelection.instanceId));
      if (!instance?.enabled || instance.driverKind !== "pi" || !instance.potetoWorker)
        throw new Error("This run requires an enabled Pi instance with restricted worker support.");
      // Hash durable IDs rather than accepting filesystem paths from the client.
      const directory = runDirectory(stateDir, threadId, run.runId);
      NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const metadataPath = NodePath.join(directory, "pilot.json");
      if (!NodeFS.existsSync(metadataPath) && journal.read().length > 0)
        throw new Error(
          "The pinned Poteto artifact directory is missing. Start a new run; the original check cannot be replaced.",
        );
      const metadata = NodeFS.existsSync(metadataPath)
        ? readPotetoProjectMetadata(directory)
        : await preparePotetoProjectPilot({
            project: workspace,
            spec: run.spec,
            runDirectory: directory,
            imageId: await resolvePotetoImage(),
          });
      signal.throwIfAborted();
      if (JSON.stringify(metadata.spec) !== JSON.stringify(run.spec))
        throw new Error("Pinned pilot scope differs from the requested run.");
      await resolvePotetoImage(metadata.imageId);
      if (journal.read().length === 0)
        await createPotetoMode(journal, {
          task: metadata.spec.task,
          files: metadata.files,
          editablePaths: metadata.spec.editableFiles,
          checkId: metadata.checkId,
        });
      assertPotetoProjectJournal(metadata, journal.read());
      const cwd = NodePath.join(directory, "worker");
      const agentDir = NodePath.join(directory, "agent");
      NodeFS.mkdirSync(cwd, { recursive: true, mode: 0o700 });
      NodeFS.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
      const thinking = getModelSelectionStringOptionValue(
        run.modelSelection,
        PI_THINKING_DESCRIPTOR_ID,
      );
      const model = thinking ? `${run.modelSelection.model}:${thinking}` : run.modelSelection.model;
      const state = await runPotetoMode({
        journal,
        probe: createPotetoProjectProbe({ ...metadata, runDirectory: directory }),
        worker: (request) => instance.potetoWorker!({ cwd, agentDir, model }, request),
        signal,
        retryBlocked: true,
        resumeInterrupted: true,
      });
      signal.throwIfAborted();
      const progress: PotetoProgress = {
        runId: run.runId,
        attemptId: run.attemptId,
        status: state.status === "candidate-ready" ? "candidate-ready" : "blocked",
        phase: state.phase ?? null,
        reason: state.reason ?? null,
        baseCommit: metadata.commit,
        revision: potetoRevision(state.files),
      };
      if (state.status === "candidate-ready")
        return recoverThreadPotetoCandidate(stateDir, {
          threadId,
          run: { ...run, events: journal.read() },
        });
      return progress;
    },
  });
});
export const layer = Layer.effect(ThreadPotetoRunner, make);
