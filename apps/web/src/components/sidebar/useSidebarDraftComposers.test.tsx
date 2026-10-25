import { EnvironmentId, ProjectId, ThreadId } from "@getpaperplane/contracts";
import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DraftId,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  useComposerDraftStore,
} from "../../composerDraftStore";
import { useSidebarDraftComposers } from "./useSidebarDraftComposers";

const environmentId = EnvironmentId.make("sidebar-drafts-test");
const projectId = ProjectId.make("project");
const active = DraftId.make("active");
const inactive = DraftId.make("inactive");
const otherProject = DraftId.make("other-project");
const projectKeys = new Set([`${environmentId}:${projectId}`]);
let renderer: ReactTestRenderer | null = null;
let observed: ReturnType<typeof useSidebarDraftComposers>[] = [];
let wholeMapRenders = 0;

function makeImage(id: string): ComposerImageAttachment {
  const file = new File([new Uint8Array(4)], `${id}.png`, { type: "image/png" });
  return {
    type: "image",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: `blob:${id}`,
    file,
  };
}

function makeFile(id: string): ComposerFileAttachment {
  const file = new File(["report"], `${id}.pdf`, { type: "application/pdf" });
  return {
    type: "file",
    id,
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    file,
  };
}

function WholeMapProbe() {
  useComposerDraftStore((store) => store.draftsByThreadKey);
  wholeMapRenders++;
  return null;
}

function Probe({ routeDraftId }: { routeDraftId: string | null }) {
  observed.push(useSidebarDraftComposers(routeDraftId, projectKeys));
  return null;
}

async function render(routeDraftId: string | null) {
  await act(() => {
    const tree = (
      <>
        <WholeMapProbe />
        <Probe routeDraftId={routeDraftId} />
      </>
    );
    if (renderer) renderer.update(tree);
    else renderer = create(tree);
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  const store = useComposerDraftStore.getState();
  for (const draftId of [active, inactive, otherProject]) {
    store.setProjectDraftThreadId(
      { environmentId, projectId: draftId === otherProject ? ProjectId.make("other") : projectId },
      draftId,
      { threadId: ThreadId.make(`thread-${draftId}`) },
    );
    store.setPrompt(draftId, `Saved ${draftId}`);
  }
  observed = [];
  wholeMapRenders = 0;
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = null;
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
  vi.unstubAllGlobals();
});

describe("sidebar live draft subscription", () => {
  it("ignores 40 active-thread, active-draft and out-of-scope edits, but updates inactive drafts", async () => {
    await render(active);
    const initial = observed[0]!;
    expect(Object.keys(initial)).toEqual([inactive]);
    const store = useComposerDraftStore.getState();
    for (let index = 0; index < 40; index++) {
      await act(() => {
        store.setPrompt(active, `Typing ${index}`);
        store.setPrompt(
          { environmentId, threadId: ThreadId.make("real-thread") },
          `Thread ${index}`,
        );
        store.setPrompt(otherProject, `Other ${index}`);
      });
    }
    expect(observed).toHaveLength(1);
    expect(wholeMapRenders).toBe(41);
    expect(store.getComposerDraft(active)?.prompt).toBe("Typing 39");

    await act(() => store.setPrompt(inactive, "Changed saved draft"));
    expect(observed).toHaveLength(2);
    expect(observed.at(-1)?.[inactive]?.prompt).toBe("Changed saved draft");
    expect(observed.at(-1)).not.toBe(initial);

    await render(inactive);
    expect(Object.keys(observed.at(-1)!)).toEqual([active]);
    expect(observed.at(-1)?.[active]?.prompt).toBe("Typing 39");
  });

  it("surfaces an inactive draft that holds only attachments", async () => {
    await render(active);
    const store = useComposerDraftStore.getState();
    await act(() => store.setPrompt(inactive, ""));
    expect(observed.at(-1)?.[inactive]).toBeUndefined();

    await act(() => store.addImages(inactive, [makeImage("image-1")]));
    expect(observed.at(-1)?.[inactive]?.prompt).toBe("");
    expect(observed.at(-1)?.[inactive]?.images.map((image) => image.id)).toEqual(["image-1"]);

    await act(() => store.addFiles(inactive, [makeFile("file-1")], { appendReference: false }));
    expect(observed.at(-1)?.[inactive]?.files.map((file) => file.id)).toEqual(["file-1"]);
    expect(observed.at(-1)?.[inactive]?.images.map((image) => image.id)).toEqual(["image-1"]);
  });

  it("observes clearing content and removes promoted drafts", async () => {
    await render(active);
    const store = useComposerDraftStore.getState();
    await act(() => store.setPrompt(inactive, ""));
    expect(observed.at(-1)?.[inactive]).toBeUndefined();
    await act(() => store.setPrompt(inactive, "Restored"));
    expect(observed.at(-1)?.[inactive]?.prompt).toBe("Restored");
    await act(() => store.markDraftThreadPromoting(inactive));
    expect(observed.at(-1)).toEqual({});
    await act(() => store.finalizePromotedDraftThread(inactive));
    expect(observed.at(-1)).toEqual({});
  });
});
