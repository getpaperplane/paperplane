// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { potetoPilotFixtureReport } from "../../provider/testFixtures/potetoPilotFixture.ts";
import { replayPotetoMode, runPotetoMode, type PotetoWorker } from "./PotetoMode.ts";
import {
  assertPotetoProjectJournal,
  createPotetoProjectPilot,
  preparePotetoProjectPilot,
  readPotetoProjectMetadata,
  exportPotetoProjectPatch,
  reopenPotetoProjectPilot,
  snapshotPotetoProject,
} from "./PotetoProjectPilot.ts";
import {
  potetoProjectCheckId,
  runPotetoCommand,
  type PotetoProjectSpec,
} from "./PotetoProjectRunner.ts";

const imageId = `sha256:${"a".repeat(64)}`;
const spec: PotetoProjectSpec = {
  task: "Fix the dependency-free export's boundary, without changing read-only context.",
  editableFiles: ["subject.ts"],
  contextFiles: ["context.txt"],
  check: { module: "subject.ts", export: "value", cases: [{ args: [], expected: 1 }] },
};
const original = "export const value = () => 0;\n";
const candidate = "export const value = () => 1;\n";
const worker: PotetoWorker = async (request) => ({
  report: potetoPilotFixtureReport(request.role),
  readPaths: ["subject.ts"],
  files:
    request.role === "implement"
      ? request.files.map((file) =>
          file.path === "subject.ts" ? { ...file, content: candidate } : file,
        )
      : request.files,
});

describe("Poteto project snapshot and durable pilot", () => {
  let directory: string;
  let project: string;
  let runDirectory: string;
  const git = async (...args: string[]) => {
    const result = await runPotetoCommand("git", ["-C", project, ...args]);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.toString("utf8");
  };
  beforeEach(async () => {
    directory = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-poteto-pilot-test-")),
    );
    project = NodePath.join(directory, "project");
    runDirectory = NodePath.join(directory, "run");
    NodeFS.mkdirSync(project);
    NodeFS.mkdirSync(runDirectory);
    NodeFS.writeFileSync(NodePath.join(project, "subject.ts"), original);
    NodeFS.writeFileSync(NodePath.join(project, "context.txt"), "Read only.\n");
    await git("init", "--quiet");
    await git("add", "subject.ts", "context.txt");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "baseline",
    );
  });
  afterEach(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  const create = () => createPotetoProjectPilot({ project, spec, runDirectory, imageId });
  const run = (
    pilot: Awaited<ReturnType<typeof create>>,
    overrides: Partial<Parameters<typeof runPotetoMode>[0]> = {},
  ) =>
    runPotetoMode({
      journal: pilot.journal,
      worker,
      // This trusted stub tests persistence and gates; Docker execution has its own tests.
      probe: {
        id: pilot.metadata.checkId,
        run: async (files) => ({
          outcome: files[0]?.content === original ? "fail" : "pass",
          output: "Host boundary comparison.",
        }),
      },
      signal: new AbortController().signal,
      ...overrides,
    });

  it("prepares and reads an exclusive pinned baseline without opening SQLite", async () => {
    const metadata = await preparePotetoProjectPilot({ project, spec, runDirectory, imageId });
    NodeFS.writeFileSync(NodePath.join(project, "subject.ts"), "later checkout change");
    expect(readPotetoProjectMetadata(runDirectory)).toEqual(metadata);
    expect(NodeFS.readdirSync(runDirectory)).toEqual(["pilot.json"]);
    await expect(
      preparePotetoProjectPilot({ project, spec, runDirectory, imageId }),
    ).rejects.toThrow();
    expect(readPotetoProjectMetadata(runDirectory)).toEqual(metadata);
    NodeFS.writeFileSync(
      NodePath.join(runDirectory, "pilot.json"),
      JSON.stringify({ ...metadata, checkId: "changed" }),
    );
    expect(() => readPotetoProjectMetadata(runDirectory)).toThrow("runner changed");
    expect(NodeFS.readdirSync(runDirectory)).toEqual(["pilot.json"]);
  });

  it("validates baseline identity and replays supplied journal events", async () => {
    const pilot = await create();
    try {
      const events = pilot.journal.read();
      expect(() => assertPotetoProjectJournal(pilot.metadata, events)).not.toThrow();
      expect(() => assertPotetoProjectJournal(pilot.metadata, [])).toThrow("durable run");
      for (const metadata of [
        { ...pilot.metadata, checkId: "changed" },
        { ...pilot.metadata, spec: { ...spec, task: "changed" } },
        { ...pilot.metadata, spec: { ...spec, editableFiles: ["context.txt"] } },
        { ...pilot.metadata, files: [{ path: "subject.ts", content: "changed" }] },
      ]) {
        expect(() => assertPotetoProjectJournal(metadata, events)).toThrow("durable run");
      }
      expect(() => assertPotetoProjectJournal(pilot.metadata, [...events, events[0]!])).toThrow();
    } finally {
      pilot.journal.close();
    }
  });

  it("pins committed blobs, excluding dirty, untracked, and ignored workspace content", async () => {
    const commit = (await git("rev-parse", "HEAD")).trim();
    NodeFS.writeFileSync(NodePath.join(project, "subject.ts"), "dirty data");
    NodeFS.writeFileSync(NodePath.join(project, "untracked.ts"), "untracked data");
    NodeFS.writeFileSync(NodePath.join(project, ".gitignore"), "ignored.ts\n");
    NodeFS.writeFileSync(NodePath.join(project, "ignored.ts"), "ignored data");
    const snapshot = await snapshotPotetoProject(project, spec, runDirectory);
    expect(snapshot).toEqual({
      commit,
      files: [
        { path: "subject.ts", content: original },
        { path: "context.txt", content: "Read only.\n" },
      ],
    });
    for (const path of ["untracked.ts", "ignored.ts", ".gitignore"]) {
      await expect(
        snapshotPotetoProject(project, { ...spec, contextFiles: [path] }, runDirectory),
      ).rejects.toThrow();
    }
    expect(NodeFS.readFileSync(NodePath.join(project, "subject.ts"), "utf8")).toBe("dirty data");
  });

  it("rejects committed symlinks, directories, binary content, and oversized snapshots", async () => {
    NodeFS.symlinkSync("subject.ts", NodePath.join(project, "link.ts"));
    NodeFS.mkdirSync(NodePath.join(project, "folder.ts"));
    NodeFS.writeFileSync(NodePath.join(project, "folder.ts", "child"), "nested");
    NodeFS.writeFileSync(NodePath.join(project, "binary.ts"), Buffer.from([0xff, 0xfe]));
    NodeFS.writeFileSync(NodePath.join(project, "huge.ts"), "x".repeat(33_000));
    await git("add", ".");
    await git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--quiet",
      "-m",
      "unsupported files",
    );
    for (const path of ["link.ts", "folder.ts", "binary.ts", "huge.ts"]) {
      await expect(
        snapshotPotetoProject(project, { ...spec, contextFiles: [path] }, runDirectory),
      ).rejects.toThrow();
    }
  });

  it("exports an applicable reviewed patch without modifying the checkout, index, or HEAD", async () => {
    const pilot = await create();
    try {
      const before = {
        commit: await git("rev-parse", "HEAD"),
        status: await git("status", "--porcelain"),
        diff: await git("diff", "--cached"),
      };
      const state = await run(pilot);
      expect(state.status).toBe("candidate-ready");
      const patch = exportPotetoProjectPatch(runDirectory, pilot.metadata, state);
      expect(NodeFS.readFileSync(patch, "utf8")).toContain("-export const value = () => 0;");
      expect(NodeFS.readFileSync(patch, "utf8")).not.toContain("context.txt");
      await git("apply", "--check", patch);
      expect({
        commit: await git("rev-parse", "HEAD"),
        status: await git("status", "--porcelain"),
        diff: await git("diff", "--cached"),
      }).toEqual(before);
      expect(NodeFS.readFileSync(NodePath.join(project, "subject.ts"), "utf8")).toBe(original);
      expect(
        JSON.parse(NodeFS.readFileSync(NodePath.join(runDirectory, "candidate.json"), "utf8")),
      ).toMatchObject({
        baseCommit: pilot.metadata.commit,
        checkId: pilot.metadata.checkId,
        files: ["subject.ts"],
        review: state.lastReview,
      });
    } finally {
      pilot.journal.close();
    }
  });

  it("does not export an unfinished or blocked run", async () => {
    const pilot = await create();
    try {
      expect(() =>
        exportPotetoProjectPatch(
          runDirectory,
          pilot.metadata,
          replayPotetoMode(pilot.journal.read()),
        ),
      ).toThrow("candidate-ready");
      const state = await run(pilot, {
        probe: {
          id: pilot.metadata.checkId,
          run: async () => ({ outcome: "inconclusive", output: "Unsupported module." }),
        },
      });
      expect(state).toMatchObject({ status: "blocked", phase: "reproduce" });
      expect(() => exportPotetoProjectPatch(runDirectory, pilot.metadata, state)).toThrow(
        "candidate-ready",
      );
      expect(NodeFS.existsSync(NodePath.join(runDirectory, "candidate.patch"))).toBe(false);
    } finally {
      pilot.journal.close();
    }
  });

  it("blocks edits to read-only context even from a worker that returns a valid report", async () => {
    const pilot = await create();
    try {
      const state = await run(pilot, {
        worker: async (request) => {
          const result = await worker(request);
          return request.role === "implement"
            ? {
                ...result,
                files: result.files.map((file) =>
                  file.path === "context.txt" ? { ...file, content: "mutated" } : file,
                ),
              }
            : result;
        },
      });
      expect(state).toMatchObject({
        status: "blocked",
        phase: "implement",
        reason: expect.stringContaining("read-only context"),
      });
      expect(state.files).toEqual(pilot.metadata.files);
    } finally {
      pilot.journal.close();
    }
  });

  it("recovers an interrupted phase with the original pinned snapshot and check", async () => {
    const pilot = await create();
    const controller = new AbortController();
    await expect(
      run(pilot, {
        onEvent: (event) => {
          if (event.type === "accepted" && event.phase === "design") controller.abort();
        },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    // Simulate a lost host after it recorded intent, but before its worker returned.
    pilot.journal.append(pilot.journal.read().length, { type: "started", phase: "implement" });
    const metadata = pilot.metadata;
    pilot.journal.close();
    NodeFS.writeFileSync(NodePath.join(project, "subject.ts"), "later checkout change");
    const reopened = reopenPotetoProjectPilot(runDirectory);
    try {
      expect(reopened.metadata).toEqual(metadata);
      const roles: string[] = [];
      expect(await run(reopened)).toMatchObject({ status: "running", phase: "implement" });
      const state = await run(reopened, {
        resumeInterrupted: true,
        retryBlocked: true,
        worker: async (request) => {
          roles.push(request.role);
          return worker(request);
        },
      });
      expect(state.status).toBe("candidate-ready");
      expect(roles).toEqual(["implement", "review"]);
      expect(state.checkId).toBe(metadata.checkId);
    } finally {
      reopened.journal.close();
    }
  });

  it("rejects altered check definitions, even with a recomputed metadata identity", async () => {
    const pilot = await create();
    pilot.journal.close();
    const metadata = {
      ...pilot.metadata,
      spec: { ...spec, check: { ...spec.check, cases: [{ args: [], expected: 0 }] } },
    };
    NodeFS.writeFileSync(NodePath.join(runDirectory, "pilot.json"), JSON.stringify(metadata));
    expect(() => reopenPotetoProjectPilot(runDirectory)).toThrow("runner changed");
    metadata.checkId = potetoProjectCheckId(metadata.commit, metadata.spec, imageId);
    NodeFS.writeFileSync(NodePath.join(runDirectory, "pilot.json"), JSON.stringify(metadata));
    expect(() => reopenPotetoProjectPilot(runDirectory)).toThrow("durable run");
  });

  it("never replaces the metadata or journal of an existing pilot", async () => {
    const pilot = await create();
    try {
      const metadata = NodeFS.readFileSync(NodePath.join(runDirectory, "pilot.json"), "utf8");
      await expect(create()).rejects.toThrow();
      expect(NodeFS.readFileSync(NodePath.join(runDirectory, "pilot.json"), "utf8")).toBe(metadata);
      expect(pilot.journal.read()).toHaveLength(1);
    } finally {
      pilot.journal.close();
    }
  });
});
