// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { CommandId, ProviderInstanceId, ThreadId } from "@rove-code/contracts";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { potetoFixtureReport } from "../../provider/testFixtures/potetoFixture.ts";
import { createPotetoMode, runPotetoMode, type PotetoEvent } from "./PotetoMode.ts";
import { potetoProjectCheckId } from "./PotetoProjectRunner.ts";
import { recoverThreadPotetoCandidate } from "./ThreadPotetoRunner.ts";
import type { ThreadPotetoRun } from "./ThreadPotetoState.ts";

const spec = {
  task: "Fix the return value",
  editableFiles: ["subject.ts"],
  contextFiles: [],
  check: { module: "subject.ts", export: "value", cases: [{ args: [], expected: 1 }] },
};
const files = [{ path: "subject.ts", content: "export const value = () => 0;\n" }];
const threadId = ThreadId.make("patch-recovery");
const runId = CommandId.make("approved-candidate");
const commit = "a".repeat(40);
const imageId = `sha256:${"b".repeat(64)}`;

describe("Poteto candidate artifact recovery", () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0))
      NodeFS.rmSync(directory, { recursive: true, force: true });
  });

  it("regenerates the exact approved patch from pinned artifacts and durable events without executing a check or model", async () => {
    const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-poteto-recover-"));
    directories.push(stateDir);
    const directory = NodePath.join(
      stateDir,
      "poteto",
      NodeCrypto.createHash("sha256")
        .update(JSON.stringify([threadId, runId]))
        .digest("hex"),
    );
    NodeFS.mkdirSync(directory, { recursive: true });
    const checkId = potetoProjectCheckId(commit, spec, imageId);
    NodeFS.writeFileSync(
      NodePath.join(directory, "pilot.json"),
      JSON.stringify({ version: "node-export-pilot-v1", commit, imageId, checkId, spec, files }),
    );
    const events: PotetoEvent[] = [];
    const journal = {
      read: () => events,
      append: (_length: number, event: PotetoEvent) => {
        events.push(event);
      },
    };
    await createPotetoMode(journal, {
      task: spec.task,
      files,
      checkId,
      editablePaths: spec.editableFiles,
    });
    const state = await runPotetoMode({
      journal,
      signal: new AbortController().signal,
      probe: {
        id: checkId,
        run: async (candidate) => ({
          outcome: candidate[0]!.content.includes("=> 1") ? "pass" : "fail",
          output: "Trusted fixture comparison",
        }),
      },
      worker: async (request) => ({
        report: potetoFixtureReport(request.role),
        readPaths: ["subject.ts"],
        files:
          request.role === "implement"
            ? request.files.map((file) => ({
                ...file,
                content: file.content.replace("=> 0", "=> 1"),
              }))
            : request.files,
      }),
    });
    expect(state.status).toBe("candidate-ready");
    const run: ThreadPotetoRun = {
      runId,
      attemptId: runId,
      attemptCount: 1,
      spec,
      modelSelection: {
        instanceId: ProviderInstanceId.make("pi"),
        model: "not-resolvable-and-not-needed",
      },
      events,
      progress: { runId, attemptId: runId, status: "candidate-ready", phase: null, reason: null },
    };
    expect(NodeFS.existsSync(NodePath.join(directory, "candidate.patch"))).toBe(false);
    const progress = recoverThreadPotetoCandidate(stateDir, { threadId, run });
    expect(progress).toMatchObject({ status: "candidate-ready", baseCommit: commit });
    expect(progress.patch).toContain("-export const value = () => 0;");
    expect(progress.patch).toContain("+export const value = () => 1;");
    NodeFS.rmSync(NodePath.join(directory, "candidate.patch"));
    expect(recoverThreadPotetoCandidate(stateDir, { threadId, run })).toEqual(progress);
    expect(NodeFS.existsSync(NodePath.join(directory, "poteto.sqlite"))).toBe(false);
    expect(() =>
      recoverThreadPotetoCandidate(stateDir, {
        threadId,
        run: { ...run, events: events.slice(0, -1) },
      }),
    ).toThrow("candidate-ready");
  });
});
