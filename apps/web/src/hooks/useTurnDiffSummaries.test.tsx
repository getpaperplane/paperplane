import type { OrchestrationV2ThreadProjection } from "@rove-code/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { makeThreadProjectionFixture } from "../test-fixtures";
import { useTurnDiffSummaries } from "./useTurnDiffSummaries";

let renderer: ReactTestRenderer | null = null;
let observed: Array<ReturnType<typeof useTurnDiffSummaries>["turnDiffSummaries"]> = [];

function Probe({ projection }: { projection: OrchestrationV2ThreadProjection }) {
  observed.push(useTurnDiffSummaries(projection).turnDiffSummaries);
  return null;
}

async function render(projection: OrchestrationV2ThreadProjection) {
  await act(() => {
    if (renderer) renderer.update(<Probe projection={projection} />);
    else renderer = create(<Probe projection={projection} />);
  });
}

beforeEach(() => {
  observed = [];
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  vi.unstubAllGlobals();
});

describe("useTurnDiffSummaries", () => {
  it("keeps the same summaries array when only turn items change", async () => {
    const base = makeThreadProjectionFixture();
    await render(base);
    await render({ ...base, turnItems: [] });

    expect(observed).toHaveLength(2);
    expect(observed[1]).toBe(observed[0]);
  });
});
