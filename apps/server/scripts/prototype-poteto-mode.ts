// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Standalone prototype, not the application server.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import * as Schema from "effect/Schema";
import {
  createPotetoMode,
  replayPotetoMode,
  runPotetoMode,
} from "../src/orchestration/poteto/PotetoMode.ts";
import { openPotetoModeJournal } from "../src/orchestration/poteto/PotetoModeJournal.ts";
import { createPiPotetoWorker } from "../src/provider/Layers/PiPotetoWorker.ts";
import {
  POTETO_FIXTURE_FILES,
  POTETO_FIXTURE_TASK,
  potetoFixtureProbe,
  registerPotetoFixtureModel,
} from "../src/provider/testFixtures/potetoFixture.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    help: { type: "boolean" },
    model: { type: "string" },
    behavior: { type: "string", default: "cooperate" },
    resume: { type: "string" },
    retry: { type: "boolean" },
  },
});
if (values.help) {
  console.log(`Native Poteto Mode candidate-validation prototype. No slash skill or app setting.

node apps/server/scripts/prototype-poteto-mode.ts
node apps/server/scripts/prototype-poteto-mode.ts --behavior attempt-bypass
node apps/server/scripts/prototype-poteto-mode.ts --behavior skip-report
node apps/server/scripts/prototype-poteto-mode.ts --model <pi-provider/model[:thinking]>
node apps/server/scripts/prototype-poteto-mode.ts --behavior repair-implement
node apps/server/scripts/prototype-poteto-mode.ts --resume <printed-run-directory> --retry

Default runs use a scripted provider through the real Pi SDK; no credentials or paid calls.
--model uses your Pi credentials but never loads extensions or skills.
All worker edits stay in a bounded in-memory snapshot. The check interprets JSON, not code.
A separate SQLite journal preserves progress and rejected review reports. No live Rove state is accessed.
Observations do not block acceptance. Actionable rejection triggers up to two repair rounds;
each repaired candidate is verified and independently reviewed again. Model reasoning suffixes
are honored (the SDK may clamp them to the model's capabilities).
Completion means candidate-ready, not committed or published. This is a partial playbook,
not full Poteto Mode: runtime hypothesis experiments, adversarial multi-model design,
commit sequencing, and PR workflows are not yet implemented.
Inspired by Lauren Tan's pstack Poteto Mode (MIT).`);
} else {
  const behavior = Schema.decodeUnknownSync(
    Schema.Literals([
      "cooperate",
      "attempt-bypass",
      "skip-report",
      "forged-evidence",
      "bad-fix",
      "reject-review",
      "accept-observation",
      "repair-implement",
      "repair-investigate",
      "endless-repair",
    ]),
  )(values.behavior);
  const directory = values.resume
    ? NodeFS.realpathSync(values.resume)
    : NodeFS.realpathSync(
        NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-poteto-prototype-")),
      );
  if (!NodePath.basename(directory).startsWith("rove-poteto-prototype-"))
    throw new Error("Resume requires a prototype run directory.");
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
  const model = values.model ?? registerPotetoFixtureModel(runtime, behavior);
  const journal = openPotetoModeJournal(NodePath.join(directory, "poteto.sqlite"));
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("Stopped by the operator."));
  process.once("SIGINT", stop);
  console.log(`Run directory: ${directory}\nModel: ${model}`);
  let reviewPrinted = false;
  const printReview = (review: ReturnType<typeof replayPotetoMode>["lastReview"]) => {
    if (!review) return;
    console.log(`Review report:\n${JSON.stringify(review, null, 2)}`);
    reviewPrinted = true;
  };
  try {
    if (!values.resume)
      createPotetoMode(journal, {
        task: POTETO_FIXTURE_TASK,
        files: POTETO_FIXTURE_FILES,
        checkId: potetoFixtureProbe.id,
      });
    const state = await runPotetoMode({
      journal,
      probe: potetoFixtureProbe,
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
        if (
          event.type !== "created" &&
          event.phase === "review" &&
          (event.type === "accepted" || event.type === "blocked") &&
          event.result !== undefined
        )
          printReview(replayPotetoMode(journal.read()).lastReview);
      },
    });
    console.log(`Result: ${state.status}${state.reason ? ` (${state.reason})` : ""}`);
    if (!reviewPrinted) printReview(state.lastReview);
    for (const entry of replayPotetoMode(journal.read()).accepted) {
      if (entry.phase === "reproduce" || entry.phase === "verify")
        console.log(`${entry.phase} evidence:\n${JSON.stringify(entry.result, null, 2)}`);
    }
    if (state.status !== "candidate-ready") process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    journal.close();
  }
}
