// @effect-diagnostics nodeBuiltinImport:off - Prototype host, shared with the Pi runtime worker.
import * as NodeCrypto from "node:crypto";
import * as Schema from "effect/Schema";

/** Native candidate-validation slice of Lauren Tan's Poteto Mode bug-fix playbook.
 * Commit sequencing and publishing are deliberately outside this prototype.
 * Source (MIT, see LICENSE.pstack):
 * https://github.com/poteto/plugins/blob/74dd2291e8e37b12fd6dc49b2acbd655c6bdaf12/pstack/skills/poteto-mode/playbooks/bug-fix.md
 */
export const POTETO_PHASES = [
  "reproduce",
  "investigate",
  "design",
  "implement",
  "verify",
  "review",
] as const;
export const POTETO_VERSION = "bug-fix-prototype-v2";
const Phase = Schema.Literals(POTETO_PHASES);
export type PotetoPhase = typeof Phase.Type;
const Text = Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4096));
export const PotetoFiles = Schema.Array(
  Schema.Struct({ path: Text, content: Schema.String }),
).check(Schema.isMinLength(1), Schema.isMaxLength(16));
export type PotetoFiles = typeof PotetoFiles.Type;
const decodeFiles = Schema.decodeUnknownSync(PotetoFiles);
export function decodePotetoFiles(input: unknown): PotetoFiles {
  const files = decodeFiles(input);
  if (new Set(files.map((file) => file.path)).size !== files.length)
    throw new Error("Duplicate snapshot path.");
  if (JSON.stringify(files).length > 32_768)
    throw new Error("Snapshot exceeds the prototype's context budget.");
  return files;
}
export function potetoRevision(files: PotetoFiles): string {
  return NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify(files.toSorted((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))),
    )
    .digest("hex");
}
const Report = Schema.Struct({
  summary: Text,
  evidenceIds: Schema.Array(Text).check(Schema.isMinLength(1), Schema.isMaxLength(4)),
});
const Diagnosis = Schema.Struct({
  ...Report.fields,
  mechanism: Text,
  hypotheses: Schema.Array(Text).check(Schema.isMinLength(2), Schema.isMaxLength(4)),
});
const Design = Schema.Struct({ ...Report.fields, dataModel: Text, approach: Text });
const Plan = Schema.Struct({
  ...Report.fields,
  selected: Schema.Literals(["design-a", "design-b"]),
  rationale: Text,
});
const Review = Schema.Struct({
  ...Report.fields,
  verdict: Schema.Literals(["accept", "reject"]),
  findings: Schema.Array(
    Schema.Struct({
      severity: Schema.Literals(["blocker", "observation"]),
      message: Text,
    }),
  ).check(Schema.isMaxLength(8)),
  repairTarget: Schema.NullOr(Schema.Literals(["implement", "investigate"])),
});
const LegacyReview = Schema.Struct({
  ...Report.fields,
  verdict: Schema.Literals(["accept", "reject"]),
  findings: Schema.Array(Text).check(Schema.isMaxLength(8)),
});
const Execution = Schema.Struct({ model: Text, thinkingLevel: Text });
export const POTETO_REPORTS = {
  how: Report,
  why: Report,
  diagnose: Diagnosis,
  "design-a": Design,
  "design-b": Design,
  plan: Plan,
  implement: Report,
  review: Review,
} as const;
export type PotetoRole = keyof typeof POTETO_REPORTS;
const decodeReport = Schema.decodeUnknownSync(Report);
const decodeDiagnosis = Schema.decodeUnknownSync(Diagnosis);
const decodeDesign = Schema.decodeUnknownSync(Design);
const decodePlan = Schema.decodeUnknownSync(Plan);
const decodeReview = Schema.decodeUnknownSync(Review);
export const POTETO_REPORT_DECODERS = {
  how: decodeReport,
  why: decodeReport,
  diagnose: decodeDiagnosis,
  "design-a": decodeDesign,
  "design-b": decodeDesign,
  plan: decodePlan,
  implement: decodeReport,
  review: decodeReview,
} as const;
export interface PotetoWorkerRequest {
  readonly role: PotetoRole;
  readonly task: string;
  readonly files: PotetoFiles;
  readonly editablePaths?: ReadonlyArray<string>;
  readonly context: unknown;
  readonly signal: AbortSignal;
}
export interface PotetoWorkerResult {
  readonly report: unknown;
  readonly files: PotetoFiles;
  readonly readPaths: ReadonlyArray<string>;
  readonly execution?: typeof Execution.Type;
}
export type PotetoWorker = (request: PotetoWorkerRequest) => Promise<PotetoWorkerResult>;
const ProbeResult = Schema.Struct({
  outcome: Schema.Literals(["fail", "pass", "inconclusive"]),
  output: Text,
});
export type PotetoProbeResult = typeof ProbeResult.Type;
export interface PotetoProbe {
  /** Versioned identity of the host-owned check; never supplied or edited by a worker. */
  readonly id: string;
  readonly run: (files: PotetoFiles, signal: AbortSignal) => Promise<PotetoProbeResult>;
}
const Evidence = Schema.Struct({
  ...ProbeResult.fields,
  id: Schema.Literals(["reproduction", "verification"]),
  checkId: Text,
  revision: Text,
});
const Investigation = Schema.Struct({ how: Report, why: Report, diagnosis: Diagnosis });
const Designs = Schema.Struct({ "design-a": Design, "design-b": Design, plan: Plan });
const Implementation = Schema.Struct({
  report: Report,
  files: PotetoFiles,
  execution: Schema.optionalKey(Execution),
});
const Reviewed = Schema.Struct({
  report: Schema.Union([Review, LegacyReview]),
  revision: Text,
  execution: Schema.optionalKey(Execution),
});
const Event = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("created"),
    version: Schema.Literals(["bug-fix-prototype-v1", POTETO_VERSION]),
    task: Text,
    checkId: Text,
    files: PotetoFiles,
    editablePaths: Schema.optionalKey(Schema.Array(Text).check(Schema.isMinLength(1))),
  }),
  Schema.Struct({ type: Schema.Literal("started"), phase: Phase }),
  Schema.Struct({ type: Schema.Literal("accepted"), phase: Phase, result: Schema.Unknown }),
  Schema.Struct({
    type: Schema.Literal("blocked"),
    phase: Phase,
    reason: Text,
    result: Schema.optionalKey(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("repair-requested"),
    phase: Schema.Literal("review"),
    target: Schema.Literals(["implement", "investigate"]),
  }),
]);
export type PotetoEvent = typeof Event.Type;
export const decodePotetoEvents = Schema.decodeUnknownSync(Schema.Array(Event));
const decodeProbeResult = Schema.decodeUnknownSync(ProbeResult);
const decodeEvidence = Schema.decodeUnknownSync(Evidence);
const decodeInvestigation = Schema.decodeUnknownSync(Investigation);
const decodeDesigns = Schema.decodeUnknownSync(Designs);
const decodeImplementation = Schema.decodeUnknownSync(Implementation);
const decodeStoredReviewed = Schema.decodeUnknownSync(Reviewed);
function decodeReviewed(input: unknown) {
  const result = decodeStoredReviewed(input);
  const report =
    "repairTarget" in result.report
      ? result.report
      : {
          ...result.report,
          findings: result.report.findings.map((message) => ({
            severity: "blocker" as const,
            message,
          })),
          repairTarget: null,
        };
  return { ...result, report };
}
type PhaseResult =
  | typeof Evidence.Type
  | typeof Investigation.Type
  | typeof Designs.Type
  | typeof Implementation.Type
  | typeof Reviewed.Type;
export interface PotetoJournal {
  readonly read: () => ReadonlyArray<PotetoEvent>;
  /** Compare-and-append. A stale owner must fail rather than overwrite another run. */
  readonly append: (expectedLength: number, event: PotetoEvent) => void | Promise<void>;
}
const MAX_ATTEMPTS = 2;
const MAX_REPAIRS = 2;

function blockingFindings(report: typeof Review.Type) {
  return report.findings.filter((finding) => finding.severity === "blocker");
}
function reviewReason(result: ReturnType<typeof decodeReviewed>) {
  const findings = blockingFindings(result.report);
  return `Independent review ${result.report.verdict}: ${findings.length ? findings.map((finding) => finding.message).join("; ") : result.report.summary}`.slice(
    0,
    4096,
  );
}
function canRepair(result: ReturnType<typeof decodeReviewed> | undefined, revision: string) {
  if (
    !result ||
    result.revision !== revision ||
    result.report.verdict !== "reject" ||
    !result.report.repairTarget ||
    blockingFindings(result.report).length === 0
  )
    return false;
  try {
    requireEvidence(result.report, "verification");
    return true;
  } catch {
    return false;
  }
}

function requireEvidence(report: typeof Report.Type, required: "reproduction" | "verification") {
  if (
    !report.evidenceIds.includes(required) ||
    report.evidenceIds.some((id) => id !== "reproduction" && id !== required)
  ) {
    throw new Error(
      `Report must cite host evidence ${required}; invented evidence is not accepted.`,
    );
  }
}

/** Replay applies the same gates as live execution; a stored out-of-order acceptance is invalid. */
export function replayPotetoMode(raw: ReadonlyArray<unknown>) {
  const events = decodePotetoEvents(raw);
  const created = events[0];
  if (!created || created.type !== "created") throw new Error("Missing Poteto Mode run.");
  let files = decodePotetoFiles(created.files);
  const editablePaths = created.editablePaths ?? files.map((file) => file.path);
  if (
    new Set(editablePaths).size !== editablePaths.length ||
    editablePaths.some((path) => !files.some((file) => file.path === path))
  )
    throw new Error("Invalid editable file scope.");
  let index = 0;
  let attempts = 0;
  let status: "ready" | "running" | "blocked" | "candidate-ready" = "ready";
  let reason: string | undefined;
  let repairs = 0;
  let lastReview: ReturnType<typeof decodeReviewed> | undefined;
  let repairFeedback: ReturnType<typeof decodeReviewed> | undefined;
  const accepted: Array<{ phase: PotetoPhase; result: unknown }> = [];
  for (const event of events.slice(1)) {
    const phase = POTETO_PHASES[index];
    if (event.type === "created" || event.phase !== phase)
      throw new Error("Poteto Mode phases cannot be skipped or reordered.");
    switch (event.type) {
      case "started":
        if (status !== "ready" && status !== "blocked") throw new Error("Phase already running.");
        if (attempts >= MAX_ATTEMPTS) throw new Error("Phase retry budget exhausted.");
        attempts++;
        status = "running";
        reason = undefined;
        break;
      case "blocked":
        if (status !== "running") throw new Error("No running phase to block.");
        status = "blocked";
        reason = event.reason;
        if (event.phase === "review" && event.result !== undefined)
          lastReview = decodeReviewed(event.result);
        break;
      case "repair-requested": {
        if (
          status !== "blocked" ||
          !canRepair(lastReview, potetoRevision(files)) ||
          lastReview?.report.repairTarget !== event.target
        )
          throw new Error(
            "Repair requires an actionable rejected review of the current candidate.",
          );
        if (repairs >= MAX_REPAIRS) throw new Error("Review repair budget exhausted.");
        repairs++;
        repairFeedback = lastReview;
        index = POTETO_PHASES.indexOf(event.target);
        accepted.splice(index);
        attempts = 0;
        status = "ready";
        reason = undefined;
        break;
      }
      case "accepted": {
        if (status !== "running") throw new Error("Only a running phase can be accepted.");
        switch (event.phase) {
          case "reproduce":
          case "verify": {
            const evidence = decodeEvidence(event.result);
            const reproduction = event.phase === "reproduce";
            if (
              evidence.id !== (reproduction ? "reproduction" : "verification") ||
              evidence.checkId !== created.checkId ||
              evidence.revision !== potetoRevision(files) ||
              evidence.outcome !== (reproduction ? "fail" : "pass")
            ) {
              throw new Error(
                reproduction
                  ? "The original bug must reproduce before investigation."
                  : "The original reproduction must pass on the candidate revision.",
              );
            }
            break;
          }
          case "investigate": {
            const result = decodeInvestigation(event.result);
            for (const report of [result.how, result.why, result.diagnosis])
              requireEvidence(report, "reproduction");
            break;
          }
          case "design": {
            const result = decodeDesigns(event.result);
            for (const report of [result["design-a"], result["design-b"], result.plan])
              requireEvidence(report, "reproduction");
            if (result["design-a"].approach === result["design-b"].approach)
              throw new Error("Design alternatives must be distinct.");
            break;
          }
          case "implement": {
            const result = decodeImplementation(event.result);
            requireEvidence(result.report, "reproduction");
            const candidate = decodePotetoFiles(result.files);
            if (
              candidate.length !== files.length ||
              candidate.some((file) => !files.some((old) => old.path === file.path))
            )
              throw new Error("Implementation changed the approved file scope.");
            if (
              candidate.some(
                (file) =>
                  !editablePaths.includes(file.path) &&
                  file.content !== files.find((old) => old.path === file.path)?.content,
              )
            )
              throw new Error("Implementation changed a read-only context file.");
            if (potetoRevision(candidate) === potetoRevision(files))
              throw new Error("Implementation returned no change.");
            files = candidate;
            break;
          }
          case "review": {
            const result = decodeReviewed(event.result);
            requireEvidence(result.report, "verification");
            if (
              result.revision !== potetoRevision(files) ||
              result.report.verdict !== "accept" ||
              blockingFindings(result.report).length !== 0 ||
              result.report.repairTarget !== null
            )
              throw new Error(
                `Independent review did not accept this candidate. ${reviewReason(result)}`,
              );
            lastReview = result;
            break;
          }
        }
        accepted.push({ phase: event.phase, result: event.result });
        index++;
        attempts = 0;
        status = index === POTETO_PHASES.length ? "candidate-ready" : "ready";
        break;
      }
    }
  }
  return {
    task: created.task,
    checkId: created.checkId,
    files,
    editablePaths,
    phase: POTETO_PHASES[index],
    attempts,
    status,
    reason,
    accepted,
    repairs,
    lastReview,
    repairFeedback,
  };
}

export function createPotetoMode(
  journal: PotetoJournal,
  input: {
    task: string;
    files: PotetoFiles;
    checkId: string;
    editablePaths?: ReadonlyArray<string>;
  },
) {
  if (journal.read().length !== 0) throw new Error("Poteto Mode journal already exists.");
  const event: PotetoEvent = {
    type: "created",
    version: POTETO_VERSION,
    ...input,
    files: decodePotetoFiles(input.files),
  };
  replayPotetoMode([event]);
  return journal.append(0, event);
}

/** Rove, not the model, chooses workers, permissions, evidence, and the next phase.
 * The host probe is trusted code. This is not a sandbox for executing arbitrary candidate programs.
 */
export async function runPotetoMode(options: {
  journal: PotetoJournal;
  worker: PotetoWorker;
  probe: PotetoProbe;
  signal: AbortSignal;
  retryBlocked?: boolean;
  /** Only set once the host knows the prior owner is gone. */
  resumeInterrupted?: boolean;
  onEvent?: (event: PotetoEvent) => void;
}) {
  let events = [...options.journal.read()];
  let state = replayPotetoMode(events);
  if (state.checkId !== options.probe.id)
    throw new Error("Cannot replace the original reproduction check.");
  const append = async (event: PotetoEvent) => {
    const next = replayPotetoMode([...events, event]);
    await options.journal.append(events.length, event);
    events.push(event);
    state = next;
    options.onEvent?.(event);
  };
  if (state.status === "running") {
    if (!options.resumeInterrupted) return state;
    await append({
      type: "blocked",
      phase: state.phase!,
      reason: "Interrupted phase. Explicit retry required.",
    });
  }
  const requestRepair = async () => {
    if (
      state.status !== "blocked" ||
      state.phase !== "review" ||
      !canRepair(state.lastReview, potetoRevision(state.files)) ||
      state.repairs >= MAX_REPAIRS
    )
      return false;
    await append({
      type: "repair-requested",
      phase: "review",
      target: state.lastReview!.report.repairTarget!,
    });
    return true;
  };
  if (state.status === "blocked") {
    if (!options.retryBlocked) return state;
    if (!(await requestRepair()) && state.attempts >= MAX_ATTEMPTS) return state;
  }
  const result = <T>(phase: PotetoPhase, decode: (input: unknown) => T): T =>
    decode(state.accepted.find((entry) => entry.phase === phase)?.result);
  const call = async <K extends PotetoRole>(role: K, context: unknown) => {
    const worker = await options.worker({
      role,
      task: state.task,
      files: structuredClone(state.files),
      editablePaths: state.editablePaths,
      context: structuredClone(
        state.repairFeedback
          ? {
              artifacts: context,
              repair: state.repairFeedback,
              originalFiles: events[0]?.type === "created" ? events[0].files : [],
            }
          : context,
      ),
      signal: options.signal,
    });
    options.signal.throwIfAborted();
    if (
      worker.readPaths.length === 0 ||
      worker.readPaths.some((path) => !state.files.some((file) => file.path === path))
    )
      throw new Error("Worker did not inspect the approved snapshot.");
    const files = decodePotetoFiles(worker.files);
    if (role !== "implement" && potetoRevision(files) !== potetoRevision(state.files))
      throw new Error("Read-only worker changed the snapshot.");
    const report = POTETO_REPORT_DECODERS[role](worker.report);
    // Review evidence is checked by the gate after its report is captured, so
    // even an invalid citation remains available for diagnosis, never for repair.
    if (role !== "review") requireEvidence(report, "reproduction");
    const artifacts = { report, files };
    if (worker.execution) return { ...artifacts, execution: worker.execution };
    return artifacts;
  };
  const pair = async <K extends PotetoRole>(roles: readonly [K, K], context: unknown) => {
    // Drain both workers, including on failure, before blocking or retrying the phase.
    const settled = await Promise.allSettled(roles.map((role) => call(role, context)));
    const first = settled[0]!;
    const second = settled[1]!;
    if (first.status === "rejected") throw first.reason;
    if (second.status === "rejected") throw second.reason;
    return [first.value.report, second.value.report] as const;
  };
  while (state.phase) {
    options.signal.throwIfAborted();
    const phase = state.phase;
    await append({ type: "started", phase });
    let output: PhaseResult | undefined;
    try {
      switch (phase) {
        case "reproduce":
        case "verify": {
          const probe = decodeProbeResult(
            await options.probe.run(structuredClone(state.files), options.signal),
          );
          output = {
            ...probe,
            id: phase === "reproduce" ? "reproduction" : "verification",
            checkId: state.checkId,
            revision: potetoRevision(state.files),
          };
          break;
        }
        case "investigate": {
          const reproduction = result("reproduce", decodeEvidence);
          const [how, why] = await pair(["how", "why"], { reproduction });
          const diagnosis = (await call("diagnose", { reproduction, how, why })).report;
          output = decodeInvestigation({ how, why, diagnosis });
          break;
        }
        case "design": {
          const context = {
            reproduction: result("reproduce", decodeEvidence),
            investigation: result("investigate", decodeInvestigation),
          };
          const [a, b] = await pair(["design-a", "design-b"], context);
          const plan = (await call("plan", { ...context, "design-a": a, "design-b": b })).report;
          output = decodeDesigns({ "design-a": a, "design-b": b, plan });
          break;
        }
        case "implement":
          output = await call("implement", {
            reproduction: result("reproduce", decodeEvidence),
            diagnosis: result("investigate", decodeInvestigation).diagnosis,
            designs: result("design", decodeDesigns),
          });
          break;
        case "review": {
          const reviewed = await call("review", {
            original: events[0],
            implementation: result("implement", decodeImplementation).report,
            reproduction: result("reproduce", decodeEvidence),
            verification: result("verify", decodeEvidence),
            plan: result("design", decodeDesigns).plan,
          });
          output = decodeReviewed({ ...reviewed, revision: potetoRevision(state.files) });
          break;
        }
      }
      options.signal.throwIfAborted();
      // Validate before persistence, but don't turn an I/O failure into a fake successful transition.
      replayPotetoMode([...events, { type: "accepted", phase, result: output }]);
    } catch (error) {
      const failure = (error instanceof Error ? error.message : String(error)) || "Phase failed.";
      const blocked = {
        type: "blocked" as const,
        phase,
        reason: `${failure.slice(0, 4000)}${phase === "review" && state.repairs >= MAX_REPAIRS ? " Review repair budget exhausted." : ""}`,
      };
      if (output !== undefined) await append({ ...blocked, result: output });
      else await append(blocked);
      // A stopped run keeps its rejection and waits for explicit operator retry.
      if (!options.signal.aborted && phase === "review" && (await requestRepair())) continue;
      return state;
    }
    await append({ type: "accepted", phase, result: output });
  }
  return state;
}
