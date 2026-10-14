import { describe, expect, it } from "vite-plus/test";
import { derivePotetoStatus } from "./potetoStatus.logic";

describe("derivePotetoStatus", () => {
  it.each(["blocked", "interrupted", "cancelled"] as const)(
    "waits for %s work to drain before retry",
    (status) => {
      expect(derivePotetoStatus({ status, phase: "verify" }, true)).toMatchObject({
        stopping: true,
        retryable: false,
      });
      expect(derivePotetoStatus({ status, phase: "verify" }, false)).toMatchObject({
        stopping: false,
        retryable: true,
      });
    },
  );
  it("does not claim preceding phases were accepted from phase position alone", () => {
    const view = derivePotetoStatus({ status: "running", phase: "implement" }, true);
    expect(
      view.phases.filter((phase) => phase.state === "current").map((phase) => phase.phase),
    ).toEqual(["implement"]);
    expect(view.phases.some((phase) => phase.state === "complete")).toBe(false);
    expect(view.action).toContain("isolated workspace");
  });
  it("presents a finished candidate as review-only, never applied", () => {
    const view = derivePotetoStatus({ status: "candidate-ready", phase: "review" }, false);
    expect(view.retryable).toBe(false);
    expect(view.action).toContain("Nothing has been applied");
    expect(view.phases).toHaveLength(6);
  });
});
