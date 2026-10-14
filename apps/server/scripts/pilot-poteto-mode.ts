// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone project pilot.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { runPotetoMode } from "../src/orchestration/poteto/PotetoMode.ts";
import {
  createPotetoProjectPilot,
  exportPotetoProjectPatch,
  reopenPotetoProjectPilot,
} from "../src/orchestration/poteto/PotetoProjectPilot.ts";
import {
  decodePotetoProjectSpecJson,
  resolvePotetoImage,
  DEFAULT_POTETO_IMAGE,
} from "../src/orchestration/poteto/PotetoProjectRunner.ts";
import { createPiPotetoWorker } from "../src/provider/Layers/PiPotetoWorker.ts";
import { registerPotetoPilotFixtureModel } from "../src/provider/testFixtures/potetoPilotFixture.ts";
import exampleSpec from "../src/provider/testFixtures/poteto-project-pilot.json" with { type: "json" };

const { values } = NodeUtil.parseArgs({
  options: {
    help: { type: "boolean" },
    project: { type: "string" },
    spec: { type: "string" },
    model: { type: "string" },
    scripted: { type: "boolean" },
    image: { type: "string" },
    resume: { type: "string" },
    retry: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Native Poteto Mode real-project pilot (dependency-free JS/TS exports).

Prepare the local image once (runs never pull images):
  docker pull ${DEFAULT_POTETO_IMAGE}

Free plumbing test on the committed Rove truncate helper:
  node apps/server/scripts/pilot-poteto-mode.ts --project . --spec apps/server/src/provider/testFixtures/poteto-project-pilot.json --scripted

Real model (paid calls are yours):
  node apps/server/scripts/pilot-poteto-mode.ts --project . --spec apps/server/src/provider/testFixtures/poteto-project-pilot.json --model <provider/model:thinking>

Resume with the original pinned check, snapshot, and image:
  node apps/server/scripts/pilot-poteto-mode.ts --resume <printed-run-directory> --model <provider/model:thinking> --retry

A spec contains task, editableFiles, contextFiles, and check {module, export, cases:[{args,expected}]}.
Only committed regular UTF-8 files from HEAD are copied; dirty, ignored, and untracked files are excluded.
The scoped checkout contains only approved files. No dependency installation, arbitrary commands,
callbacks as inputs, browser tests, workspace changes, commits, PRs, or automatic patch application.
Candidate code runs as non-root in a read-only, network-disabled Docker container with resource limits.
The container receives inputs but not expected outputs. Rove compares JSON return values itself.
Host credentials, Git metadata, Rove state, and the Docker socket are not mounted.
Unsupported modules, crashes, timeouts, and malformed output are inconclusive, never a reproduced bug.
Up to two actionable review-repair rounds are allowed. --scripted supports only the included example.
A candidate-ready run exports candidate.patch and candidate.json into its disposable run directory.`);
} else {
  if (Boolean(values.model) === Boolean(values.scripted))
    throw new Error("Choose exactly one of --model or --scripted.");
  if (values.resume && (values.project || values.spec || values.image))
    throw new Error("Resume cannot replace the pinned project, check, or image.");
  if (!values.resume && (!values.project || !values.spec))
    throw new Error("A new pilot requires --project and --spec.");
  const directory = values.resume
    ? NodeFS.realpathSync(values.resume)
    : NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-poteto-project-")),
      );
  if (!NodePath.basename(directory).startsWith("rove-poteto-project-") || directory.includes(","))
    throw new Error("Invalid pilot run directory.");
  const pilot = values.resume
    ? reopenPotetoProjectPilot(directory)
    : await createPotetoProjectPilot({
        project: values.project!,
        spec: decodePotetoProjectSpecJson(NodeFS.readFileSync(values.spec!, "utf8")),
        runDirectory: directory,
        imageId: await resolvePotetoImage(values.image ?? DEFAULT_POTETO_IMAGE),
      });
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Stopped by the operator."));
  process.once("SIGINT", stop);
  try {
    if (values.resume) await resolvePotetoImage(pilot.metadata.imageId);
    if (values.scripted && !NodeUtil.isDeepStrictEqual(pilot.metadata.spec, exampleSpec))
      throw new Error("--scripted supports only the included truncate pilot specification.");
    const cwd = NodePath.join(directory, "worker");
    const agentDir = NodePath.join(directory, "agent");
    NodeFS.mkdirSync(cwd, { recursive: true });
    NodeFS.mkdirSync(agentDir, { recursive: true });
    const runtime = values.model
      ? await ModelRuntime.create({
          authPath: NodePath.join(getAgentDir(), "auth.json"),
          modelsPath: NodePath.join(getAgentDir(), "models.json"),
        })
      : await ModelRuntime.create({
          authPath: NodePath.join(agentDir, "auth.json"),
          modelsPath: null,
          refreshOnCreate: false,
        });
    const model = values.model ?? registerPotetoPilotFixtureModel(runtime);
    console.log(
      `Run directory: ${directory}\nBase commit: ${pilot.metadata.commit}\nImage: ${pilot.metadata.imageId}\nModel: ${model}\nEditable files: ${pilot.metadata.spec.editableFiles.join(", ")}`,
    );
    const state = await runPotetoMode({
      journal: pilot.journal,
      probe: pilot.probe,
      signal: controller.signal,
      retryBlocked: values.retry ?? false,
      resumeInterrupted: values.retry ?? false,
      worker: createPiPotetoWorker({
        cwd,
        agentDir,
        modelRuntime: runtime,
        model,
        onSession: (session, role) =>
          console.log(
            `${role}: worker model=${session.model?.provider}/${session.model?.id}, thinking=${session.thinkingLevel}`,
          ),
      }),
      onEvent: (event) => {
        if (event.type !== "created")
          console.log(
            `${event.phase}: ${event.type}${event.type === "blocked" ? ` (${event.reason})` : event.type === "repair-requested" ? ` -> ${event.target}` : ""}`,
          );
        if (event.type === "blocked" && event.result !== undefined)
          console.log(`Rejected artifact:\n${JSON.stringify(event.result, null, 2)}`);
      },
    });
    console.log(`Result: ${state.status}${state.reason ? ` (${state.reason})` : ""}`);
    if (state.lastReview)
      console.log(`Review report:\n${JSON.stringify(state.lastReview, null, 2)}`);
    for (const entry of state.accepted)
      if (entry.phase === "reproduce" || entry.phase === "verify")
        console.log(`${entry.phase} evidence:\n${JSON.stringify(entry.result, null, 2)}`);
    if (state.status === "candidate-ready") {
      const patch = exportPotetoProjectPatch(directory, pilot.metadata, state);
      console.log(
        `Approved patch: ${patch}\nFrom the original repository, inspect before applying: git apply --check ${JSON.stringify(patch)}`,
      );
    } else process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    pilot.journal.close();
  }
}
