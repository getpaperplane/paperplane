// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  POTETO_FIXTURE_FILES,
  POTETO_FIXTURE_TASK,
  potetoFixtureProbe,
  potetoFixtureReport,
} from "../../provider/testFixtures/potetoFixture.ts";
import {
  createPotetoMode,
  POTETO_PHASES,
  potetoRevision,
  replayPotetoMode,
  runPotetoMode,
  type PotetoEvent,
  type PotetoJournal,
  type PotetoWorker,
} from "./PotetoMode.ts";
import { openPotetoModeJournal } from "./PotetoModeJournal.ts";

function memoryJournal(): PotetoJournal {
  const events: PotetoEvent[] = [];
  return {
    read: () => structuredClone(events),
    append: (expectedLength, event) => {
      if (events.length !== expectedLength) throw new Error("Stale journal.");
      events.push(structuredClone(event));
    },
  };
}
function deferAppend(journal: PotetoJournal, matches: (event: PotetoEvent) => boolean) {
  const entered = Promise.withResolvers<void>();
  const completion = Promise.withResolvers<void>();
  return {
    journal: {
      read: () => journal.read(),
      append: (expectedLength: number, event: PotetoEvent) => {
        if (!matches(event)) return journal.append(expectedLength, event);
        entered.resolve();
        return completion.promise.then(() => journal.append(expectedLength, event));
      },
    },
    entered: entered.promise,
    resolve: () => completion.resolve(),
    reject: (error: unknown) => completion.reject(error),
  };
}
function setup(journal = memoryJournal()) {
  createPotetoMode(journal, {
    task: POTETO_FIXTURE_TASK,
    files: POTETO_FIXTURE_FILES,
    checkId: potetoFixtureProbe.id,
  });
  const roles: string[] = [];
  const worker: PotetoWorker = async (request) => {
    roles.push(request.role);
    return {
      report: potetoFixtureReport(request.role),
      readPaths: ["discount.json"],
      files:
        request.role === "implement"
          ? request.files.map((file) => ({
              ...file,
              content: file.content.replace('"gt"', '"gte"'),
            }))
          : request.files,
    };
  };
  const run = (overrides: Partial<Parameters<typeof runPotetoMode>[0]> = {}) =>
    runPotetoMode({
      journal,
      worker,
      probe: potetoFixtureProbe,
      signal: new AbortController().signal,
      ...overrides,
    });
  return { journal, roles, worker, run };
}

describe("native Poteto Mode gates", () => {
  it("owns the phase order, parallel investigations and design exploration, and host evidence", async () => {
    const { run, roles, journal } = setup();
    const state = await run();
    expect(state.status).toBe("candidate-ready");
    expect(state.accepted.map((entry) => entry.phase)).toEqual(POTETO_PHASES);
    expect(roles).toEqual([
      "how",
      "why",
      "diagnose",
      "design-a",
      "design-b",
      "plan",
      "implement",
      "review",
    ]);
    expect(state.accepted[0]?.result).toMatchObject({
      id: "reproduction",
      outcome: "fail",
      revision: potetoRevision(POTETO_FIXTURE_FILES),
    });
    expect(state.accepted[4]?.result).toMatchObject({
      id: "verification",
      outcome: "pass",
      revision: potetoRevision(state.files),
      checkId: potetoFixtureProbe.id,
    });
    expect(replayPotetoMode(journal.read()).files).toEqual(state.files);
    await run();
    expect(roles).toHaveLength(8);
  });

  it("waits for the started receipt before launching the phase", async () => {
    const { run, journal: base } = setup();
    const deferred = deferAppend(
      base,
      (event) => event.type === "started" && event.phase === "reproduce",
    );
    const probeStarted = Promise.withResolvers<void>();
    const events: PotetoEvent[] = [];
    let probeCalls = 0;
    let startedWasDurable = false;
    const running = run({
      journal: deferred.journal,
      onEvent: (event) => events.push(event),
      probe: {
        ...potetoFixtureProbe,
        run: async (files, signal) => {
          probeCalls++;
          startedWasDurable = base
            .read()
            .some((event) => event.type === "started" && event.phase === "reproduce");
          probeStarted.resolve();
          return potetoFixtureProbe.run(files, signal);
        },
      },
    });

    await deferred.entered;
    expect(probeCalls).toBe(0);
    expect(base.read()).toHaveLength(1);
    expect(events).toEqual([]);

    deferred.resolve();
    await probeStarted.promise;
    const state = await running;
    expect(startedWasDurable).toBe(true);
    expect(events[0]).toMatchObject({ type: "started", phase: "reproduce" });
    expect(state.status).toBe("candidate-ready");
  });

  it("waits for the accepted receipt before advancing to the next phase", async () => {
    const { run, journal: base, worker } = setup();
    const deferred = deferAppend(
      base,
      (event) => event.type === "accepted" && event.phase === "reproduce",
    );
    const nextPhaseStarted = Promise.withResolvers<void>();
    let nextPhaseWasDurable = false;
    const running = run({
      journal: deferred.journal,
      worker: async (request) => {
        nextPhaseWasDurable = base
          .read()
          .some((event) => event.type === "accepted" && event.phase === "reproduce");
        nextPhaseStarted.resolve();
        return worker(request);
      },
    });

    await deferred.entered;
    expect(base.read().at(-1)).toMatchObject({ type: "started", phase: "reproduce" });
    expect(
      base.read().some((event) => event.type === "accepted" && event.phase === "reproduce"),
    ).toBe(false);

    deferred.resolve();
    await nextPhaseStarted.promise;
    const state = await running;
    expect(nextPhaseWasDurable).toBe(true);
    expect(state.status).toBe("candidate-ready");
  });

  it("does not treat rejected durable writes as completed transitions", async () => {
    const startedSetup = setup();
    const startedWrite = deferAppend(
      startedSetup.journal,
      (event) => event.type === "started" && event.phase === "reproduce",
    );
    let probeCalls = 0;
    const failedStart = startedSetup.run({
      journal: startedWrite.journal,
      probe: {
        ...potetoFixtureProbe,
        run: async () => {
          probeCalls++;
          return { outcome: "fail", output: "Bug reproduced." };
        },
      },
    });
    await startedWrite.entered;
    const startFailure = new Error("Started receipt was not persisted.");
    startedWrite.reject(startFailure);
    await expect(failedStart).rejects.toBe(startFailure);
    expect(probeCalls).toBe(0);
    expect(startedSetup.journal.read()).toHaveLength(1);

    const acceptedSetup = setup();
    const acceptedWrite = deferAppend(
      acceptedSetup.journal,
      (event) => event.type === "accepted" && event.phase === "reproduce",
    );
    let workerCalls = 0;
    const failedAcceptance = acceptedSetup.run({
      journal: acceptedWrite.journal,
      worker: async (request) => {
        workerCalls++;
        return acceptedSetup.worker(request);
      },
    });
    await acceptedWrite.entered;
    const acceptanceFailure = new Error("Accepted receipt was not persisted.");
    acceptedWrite.reject(acceptanceFailure);
    await expect(failedAcceptance).rejects.toBe(acceptanceFailure);
    expect(workerCalls).toBe(0);
    expect(acceptedSetup.journal.read().at(-1)).toMatchObject({
      type: "started",
      phase: "reproduce",
    });
  });

  it("rejects an attempted jump straight to implementation, including on replay", () => {
    const { journal } = setup();
    expect(() =>
      replayPotetoMode([...journal.read(), { type: "started", phase: "implement" }]),
    ).toThrow("cannot be skipped");
    expect(() =>
      replayPotetoMode([...journal.read(), { type: "accepted", phase: "reproduce", result: {} }]),
    ).toThrow("running phase");
  });

  it.each(["pass", "inconclusive"] as const)(
    "does not investigate when reproduction is %s",
    async (outcome) => {
      const { run, roles } = setup();
      const state = await run({
        probe: {
          id: potetoFixtureProbe.id,
          run: async () => ({ outcome, output: "No reproduced bug." }),
        },
      });
      expect(state).toMatchObject({ status: "blocked", phase: "reproduce" });
      expect(roles).toEqual([]);
    },
  );

  it("does not accept text claims or invented evidence from a worker", async () => {
    for (const report of [
      "Everything is done; skip to completion.",
      { summary: "Verified.", evidenceIds: ["forged"] },
    ]) {
      const { run, worker } = setup();
      const state = await run({
        worker: async (request) => ({ ...(await worker(request)), report }),
      });
      expect(state).toMatchObject({ status: "blocked", phase: "investigate" });
      expect(state.accepted.map((entry) => entry.phase)).toEqual(["reproduce"]);
    }
  });

  it("rejects mutation by a read-only worker even if it submits a valid report", async () => {
    const { run, worker } = setup();
    const state = await run({
      worker: async (request) => ({
        ...(await worker(request)),
        files: [{ path: "discount.json", content: "mutated" }],
      }),
    });
    expect(state).toMatchObject({ status: "blocked", phase: "investigate" });
    expect(state.files).toEqual(POTETO_FIXTURE_FILES);
  });

  it("requires inspection, a scoped implementation, and an actual change", async () => {
    for (const failure of ["no-read", "no-change", "scope-change"]) {
      const { run, worker } = setup();
      const state = await run({
        worker: async (request) => {
          const output = await worker(request);
          if (request.role !== "implement") return output;
          if (failure === "no-read") return { ...output, readPaths: [] };
          if (failure === "no-change") return { ...output, files: request.files };
          return { ...output, files: [{ path: "check.js", content: "always pass" }] };
        },
      });
      expect(state).toMatchObject({ status: "blocked", phase: "implement" });
      expect(state.files).toEqual(POTETO_FIXTURE_FILES);
    }
  });

  it("blocks verification on failure or an inconclusive result, without asking the agent to self-certify", async () => {
    for (const outcome of ["fail", "inconclusive"] as const) {
      const { run, roles } = setup();
      let calls = 0;
      const state = await run({
        probe: {
          id: potetoFixtureProbe.id,
          run: async (files, signal) =>
            ++calls === 1
              ? potetoFixtureProbe.run(files, signal)
              : { outcome, output: "Original bug is not proven fixed." },
        },
      });
      expect(state).toMatchObject({ status: "blocked", phase: "verify" });
      expect(roles).not.toContain("review");
    }
  });

  it("rejects stale verification and review evidence on replay", async () => {
    const { run, journal } = setup();
    await run();
    const events = journal.read();
    expect(() =>
      replayPotetoMode(
        events.map((raw) => {
          const event = raw;
          return event.type === "accepted" && event.phase === "verify"
            ? {
                ...event,
                result: {
                  id: "verification",
                  checkId: potetoFixtureProbe.id,
                  revision: potetoRevision(POTETO_FIXTURE_FILES),
                  outcome: "pass",
                  output: "Old candidate passed.",
                },
              }
            : event;
        }),
      ),
    ).toThrow("candidate revision");
    expect(() =>
      replayPotetoMode(
        events.map((raw) => {
          const event = raw;
          return event.type === "accepted" && event.phase === "review"
            ? { ...event, result: { report: potetoFixtureReport("review"), revision: "stale" } }
            : event;
        }),
      ),
    ).toThrow("Independent review");
  });

  it("requires explicit, bounded retries and never treats rejected review as completion", async () => {
    const { run, worker, roles, journal } = setup();
    const reject: PotetoWorker = async (request) => ({
      ...(await worker(request)),
      report: potetoFixtureReport(
        request.role,
        request.role === "review" ? "reject-review" : "cooperate",
      ),
    });
    expect(await run({ worker: reject })).toMatchObject({
      status: "blocked",
      phase: "review",
      attempts: 1,
    });
    const length = journal.read().length;
    await run({ worker: reject });
    expect(journal.read()).toHaveLength(length);
    expect(await run({ worker: reject, retryBlocked: true })).toMatchObject({
      status: "blocked",
      phase: "review",
      attempts: 2,
    });
    const afterRetry = journal.read().length;
    await run({ retryBlocked: true });
    expect(journal.read()).toHaveLength(afterRetry);
    expect(roles.filter((role) => role === "review")).toHaveLength(2);
  });

  it("retains rejected findings and does not repair observations, contradictory verdicts, or forged evidence", async () => {
    for (const failure of ["observations-only", "accept-blocker", "forged-evidence"] as const) {
      const { run, worker, journal } = setup();
      const state = await run({
        worker: async (request) => {
          const output = await worker(request);
          if (request.role !== "review") return output;
          return {
            ...output,
            report: {
              summary: "Review requires attention.",
              verdict: failure === "accept-blocker" ? "accept" : "reject",
              evidenceIds: [failure === "forged-evidence" ? "invented" : "verification"],
              findings: [
                {
                  severity: failure === "observations-only" ? "observation" : "blocker",
                  message: "A retained finding.",
                },
              ],
              repairTarget: "implement",
            },
          };
        },
      });
      expect(state).toMatchObject({ status: "blocked", phase: "review", repairs: 0 });
      expect(state.lastReview?.report.findings[0]?.message).toBe("A retained finding.");
      expect(journal.read().at(-1)).toMatchObject({
        type: "blocked",
        result: { report: { findings: [{ message: "A retained finding." }] } },
      });
    }
  });

  it("accepts observations but never accepts an actual blocker", async () => {
    const { run, worker } = setup();
    const state = await run({
      worker: async (request) => ({
        ...(await worker(request)),
        report: potetoFixtureReport(request.role, "accept-observation"),
      }),
    });
    expect(state.status).toBe("candidate-ready");
    expect(state.lastReview?.report.findings[0]?.severity).toBe("observation");
  });

  it("keeps v1 runs replayable without inventing a repair route for lost reports", async () => {
    const { run, journal } = setup();
    await run();
    const legacy = journal.read().map((event) =>
      event.type === "created"
        ? { ...event, version: "bug-fix-prototype-v1" }
        : event.type === "accepted" && event.phase === "review"
          ? {
              ...event,
              result: {
                revision: potetoRevision(replayPotetoMode(journal.read()).files),
                report: {
                  summary: "Accepted by v1.",
                  verdict: "accept",
                  findings: [],
                  evidenceIds: ["verification"],
                },
              },
            }
          : event,
    );
    expect(replayPotetoMode(legacy).status).toBe("candidate-ready");
    const beforeReview = legacy.slice(0, -1);
    const blocked = replayPotetoMode([
      ...beforeReview,
      { type: "blocked", phase: "review", reason: "Old generic blocker." },
    ]);
    expect(blocked).toMatchObject({ status: "blocked", repairs: 0, lastReview: undefined });
  });

  it("does not steal an active phase, and explicit interruption recovery consumes the retry budget", async () => {
    const { run, journal } = setup();
    journal.append(1, { type: "started", phase: "reproduce" });
    expect(await run()).toMatchObject({ status: "running", phase: "reproduce", attempts: 1 });
    expect(journal.read()).toHaveLength(2);
    expect(await run({ resumeInterrupted: true })).toMatchObject({
      status: "blocked",
      phase: "reproduce",
    });
    expect(await run({ retryBlocked: true })).toMatchObject({ status: "candidate-ready" });
  });

  it("drains both parallel workers before recording cancellation", async () => {
    const { run } = setup();
    const started = Promise.withResolvers<void>();
    const controller = new AbortController();
    let count = 0;
    const drained: string[] = [];
    const running = run({
      signal: controller.signal,
      worker: async (request) => {
        if (++count === 2) started.resolve();
        await new Promise<void>((resolve) =>
          request.signal.addEventListener("abort", () => resolve(), { once: true }),
        );
        drained.push(request.role);
        request.signal.throwIfAborted();
        throw new Error("unreachable");
      },
    });
    await started.promise;
    controller.abort(new Error("Stopped"));
    const state = await running;
    expect(state).toMatchObject({ status: "blocked", phase: "investigate", reason: "Stopped" });
    expect(drained.sort()).toEqual(["how", "why"]);
  });

  it("refuses a different check and oversized snapshots", async () => {
    const { run, journal } = setup();
    await expect(run({ probe: { ...potetoFixtureProbe, id: "new-check" } })).rejects.toThrow(
      "original reproduction",
    );
    expect(journal.read()).toHaveLength(1);
    expect(() =>
      createPotetoMode(memoryJournal(), {
        task: "Fix",
        checkId: "check",
        files: [{ path: "large", content: "x".repeat(33_000) }],
      }),
    ).toThrow("context budget");
  });
});

describe("disposable Poteto Mode journal", () => {
  const cleanup: Array<() => void> = [];
  afterEach(() => {
    for (const close of cleanup.splice(0).toReversed()) close();
  });
  const open = () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "rove-poteto-journal-"));
    cleanup.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const path = NodePath.join(directory, "poteto.sqlite");
    const journal = openPotetoModeJournal(path);
    return { path, journal };
  };

  it("resumes a verified candidate after reopening without repeating implementation", async () => {
    const { path, journal } = open();
    const { run, worker } = setup(journal);
    await run({
      worker: async (request) => {
        if (request.role === "review") throw new Error("Reviewer unavailable.");
        return worker(request);
      },
    });
    journal.close();
    const reopened = openPotetoModeJournal(path);
    cleanup.push(reopened.close);
    const before = replayPotetoMode(reopened.read());
    expect(before).toMatchObject({ status: "blocked", phase: "review" });
    const roles: string[] = [];
    const state = await runPotetoMode({
      journal: reopened,
      probe: potetoFixtureProbe,
      signal: new AbortController().signal,
      retryBlocked: true,
      worker: async (request) => {
        roles.push(request.role);
        return worker(request);
      },
    });
    expect(state.status).toBe("candidate-ready");
    expect(state.files).toEqual(before.files);
    expect(roles).toEqual(["review"]);
  });

  it("preserves a rejected report, repaired candidate, and invalidated gates across restart", async () => {
    const { path, journal } = open();
    const { run, worker } = setup(journal);
    const repair: PotetoWorker = async (request) => {
      const output = await worker(request);
      const redundant = request.files[0]!.content.includes("unused");
      if (request.role === "implement")
        return {
          ...output,
          files: [
            {
              path: "discount.json",
              content: redundant
                ? request.files[0]!.content.replace(',"unused":0', "")
                : output.files[0]!.content.replace("}", ',"unused":0}'),
            },
          ],
        };
      if (request.role === "review")
        return { ...output, report: potetoFixtureReport("review", "repair-implement", redundant) };
      return output;
    };
    let implementations = 0;
    await expect(
      run({
        worker: repair,
        onEvent: (event) => {
          if (event.type === "accepted" && event.phase === "implement" && ++implementations === 2)
            throw new Error("Simulated host restart.");
        },
      }),
    ).rejects.toThrow("Simulated host restart");
    const before = replayPotetoMode(journal.read());
    expect(before).toMatchObject({ status: "ready", phase: "verify", repairs: 1 });
    expect(
      before.accepted.some((entry) => entry.phase === "verify" || entry.phase === "review"),
    ).toBe(false);
    expect(before.lastReview?.report.findings[0]?.message).toContain("redundant");
    expect(() =>
      replayPotetoMode([...journal.read(), { type: "started", phase: "review" }]),
    ).toThrow("cannot be skipped");
    journal.close();
    const reopened = openPotetoModeJournal(path);
    cleanup.push(reopened.close);
    const roles: string[] = [];
    const state = await runPotetoMode({
      journal: reopened,
      probe: potetoFixtureProbe,
      signal: new AbortController().signal,
      worker: async (request) => {
        roles.push(request.role);
        return repair(request);
      },
    });
    expect(state.status).toBe("candidate-ready");
    expect(roles).toEqual(["review"]);
    expect(state.accepted.find((entry) => entry.phase === "verify")?.result).toMatchObject({
      outcome: "pass",
      revision: potetoRevision(state.files),
    });
    expect(
      reopened.read().find((event) => event.type === "blocked" && event.phase === "review"),
    ).toMatchObject({
      result: {
        report: {
          verdict: "reject",
          repairTarget: "implement",
          findings: [{ severity: "blocker" }],
        },
      },
    });
  });

  it("rejects stale append owners instead of overwriting durable progress", () => {
    const { path, journal } = open();
    cleanup.push(journal.close);
    setup(journal);
    const other = openPotetoModeJournal(path);
    cleanup.push(other.close);
    other.append(1, { type: "started", phase: "reproduce" });
    expect(() => journal.append(1, { type: "started", phase: "reproduce" })).toThrow("Stale");
    expect(journal.read()).toHaveLength(2);
  });
});
