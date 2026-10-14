// @effect-diagnostics nodeBuiltinImport:off - Disposable project pilot, never the application's state.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { createTwoFilesPatch } from "diff";
import * as Schema from "effect/Schema";
import {
  createPotetoMode,
  decodePotetoFiles,
  PotetoFiles,
  potetoRevision,
  replayPotetoMode,
  type PotetoEvent,
} from "./PotetoMode.ts";
import { openPotetoModeJournal } from "./PotetoModeJournal.ts";
import {
  createPotetoProjectProbe,
  PotetoProjectSpec,
  potetoProjectCheckId,
  runPotetoCommand,
  validatePotetoProjectSpec,
  type PotetoProjectSpec as ProjectSpec,
} from "./PotetoProjectRunner.ts";

const Metadata = Schema.Struct({
  version: Schema.Literal("node-export-pilot-v1"),
  commit: Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/)),
  imageId: Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/)),
  checkId: Schema.String,
  spec: PotetoProjectSpec,
  files: PotetoFiles,
});
export type PotetoProjectMetadata = typeof Metadata.Type;
const decodeMetadataJson = Schema.decodeUnknownSync(Schema.fromJsonString(Metadata));
const decodeCommit = Schema.decodeUnknownSync(Metadata.fields.commit);
const decodeTreeEntry = Schema.decodeUnknownSync(
  Schema.String.check(Schema.isPattern(/^(?:100644|100755) blob [a-f0-9]{40,64}\t[^\0]+\0$/)),
);

/** Reads exact committed blobs, not checkout filters, untracked files, or dirty working copies. */
export async function snapshotPotetoProject(
  project: string,
  spec: ProjectSpec,
  runDirectory: string,
) {
  validatePotetoProjectSpec(spec);
  const env = {
    PATH: process.env.PATH ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NodePath.join(runDirectory, "no-global-git-config"),
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_LITERAL_PATHSPECS: "1",
  };
  const git = async (args: ReadonlyArray<string>) => {
    const result = await runPotetoCommand("git", ["-C", NodePath.resolve(project), ...args], {
      env,
      maxOutputBytes: 32_768,
    });
    if (result.code !== 0)
      throw new Error(`Could not read project snapshot: ${result.stderr.slice(0, 1000)}`);
    return result.stdout;
  };
  const commit = decodeCommit(
    (await git(["rev-parse", "--verify", "HEAD^{commit}"])).toString("utf8").trim(),
  );
  const files = [];
  for (const path of [...spec.editableFiles, ...spec.contextFiles]) {
    const entry = decodeTreeEntry(
      (await git(["ls-tree", "--full-tree", "-z", commit, "--", path])).toString("utf8"),
    );
    const tab = entry.indexOf("\t");
    if (entry.slice(tab + 1, -1) !== path)
      throw new Error("Snapshot path did not match the approved literal file.");
    const object = entry.slice(0, tab).split(" ")[2]!;
    const content = new NodeUtil.TextDecoder("utf-8", { fatal: true }).decode(
      await git(["cat-file", "blob", object]),
    );
    files.push({ path, content });
  }
  return { commit, files: decodePotetoFiles(files) };
}

export async function preparePotetoProjectPilot(options: {
  project: string;
  spec: ProjectSpec;
  runDirectory: string;
  imageId: string;
}) {
  const spec = validatePotetoProjectSpec(options.spec);
  const snapshot = await snapshotPotetoProject(options.project, spec, options.runDirectory);
  const metadata: PotetoProjectMetadata = {
    version: "node-export-pilot-v1",
    ...snapshot,
    spec,
    imageId: options.imageId,
    checkId: potetoProjectCheckId(snapshot.commit, spec, options.imageId),
  };
  // A failed setup must never replace an existing pilot's check or baseline.
  NodeFS.writeFileSync(
    NodePath.join(options.runDirectory, "pilot.json"),
    JSON.stringify(metadata, null, 2),
    { flag: "wx", mode: 0o600 },
  );
  return metadata;
}

export async function createPotetoProjectPilot(
  options: Parameters<typeof preparePotetoProjectPilot>[0],
) {
  const metadata = await preparePotetoProjectPilot(options);
  const { spec } = metadata;
  const journal = openPotetoModeJournal(NodePath.join(options.runDirectory, "poteto.sqlite"));
  try {
    await createPotetoMode(journal, {
      task: spec.task,
      files: metadata.files,
      checkId: metadata.checkId,
      editablePaths: spec.editableFiles,
    });
    return {
      metadata,
      journal,
      probe: createPotetoProjectProbe({ ...metadata, runDirectory: options.runDirectory }),
    };
  } catch (error) {
    journal.close();
    throw error;
  }
}

export function readPotetoProjectMetadata(runDirectory: string): PotetoProjectMetadata {
  const metadata = decodeMetadataJson(
    NodeFS.readFileSync(NodePath.join(runDirectory, "pilot.json"), "utf8"),
  );
  validatePotetoProjectSpec(metadata.spec);
  decodePotetoFiles(metadata.files);
  if (metadata.checkId !== potetoProjectCheckId(metadata.commit, metadata.spec, metadata.imageId))
    throw new Error("Pilot check definition or runner changed. Start a new run.");
  return metadata;
}

export function assertPotetoProjectJournal(
  metadata: PotetoProjectMetadata,
  events: ReadonlyArray<PotetoEvent>,
): void {
  const initial = events[0];
  if (
    !initial ||
    initial.type !== "created" ||
    initial.checkId !== metadata.checkId ||
    initial.task !== metadata.spec.task ||
    potetoRevision(initial.files) !== potetoRevision(metadata.files) ||
    !NodeUtil.isDeepStrictEqual(initial.editablePaths, metadata.spec.editableFiles)
  )
    throw new Error("Pilot metadata does not match its durable run.");
  replayPotetoMode(events);
}

export function reopenPotetoProjectPilot(runDirectory: string) {
  const metadata = readPotetoProjectMetadata(runDirectory);
  const journal = openPotetoModeJournal(NodePath.join(runDirectory, "poteto.sqlite"));
  try {
    assertPotetoProjectJournal(metadata, journal.read());
    return { metadata, journal, probe: createPotetoProjectProbe({ ...metadata, runDirectory }) };
  } catch (error) {
    journal.close();
    throw error;
  }
}

/** Export only a verified, reviewed revision. No apply, index updates, commits, or PRs. */
export function exportPotetoProjectPatch(
  runDirectory: string,
  metadata: PotetoProjectMetadata,
  state: ReturnType<typeof replayPotetoMode>,
) {
  if (state.status !== "candidate-ready" || state.checkId !== metadata.checkId)
    throw new Error("Only a candidate-ready pilot can export an approved patch.");
  const changes = state.files.filter(
    (file) => file.content !== metadata.files.find((old) => old.path === file.path)?.content,
  );
  if (!changes.length || changes.some((file) => !metadata.spec.editableFiles.includes(file.path)))
    throw new Error("Patch changed the approved editable scope.");
  const patch = changes
    .map((file) =>
      createTwoFilesPatch(
        `a/${file.path}`,
        `b/${file.path}`,
        metadata.files.find((old) => old.path === file.path)!.content,
        file.content,
        `base ${metadata.commit}`,
        `candidate ${potetoRevision(state.files)}`,
      ),
    )
    .join("\n");
  const path = NodePath.join(runDirectory, "candidate.patch");
  NodeFS.writeFileSync(path, patch, { mode: 0o600 });
  NodeFS.writeFileSync(
    NodePath.join(runDirectory, "candidate.json"),
    JSON.stringify(
      {
        baseCommit: metadata.commit,
        revision: potetoRevision(state.files),
        checkId: metadata.checkId,
        status: state.status,
        files: changes.map((file) => file.path),
        review: state.lastReview,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return path;
}
