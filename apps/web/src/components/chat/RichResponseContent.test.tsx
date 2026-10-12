import { act, type ComponentProps } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RichResponse } from "@rove-code/contracts";
import { Button } from "../ui/button";
import { RichResponseContent } from "./RichResponseContent";

// Button's class-name utility also imports draft IDs; these tests do not own a composer store.
vi.mock("~/composerDraftStore", () => ({ DraftId: { make: (value: string) => value } }));

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", {});
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

const response: RichResponse = {
  version: 1,
  blocks: [
    {
      type: "choices",
      title: "Next",
      options: [{ label: "Explore native", prompt: "Explain native rendering." }],
    },
  ],
};

function choice() {
  // SAFETY: findByType establishes that these are the mounted Button's props.
  return renderer!.root.findByType(Button).props as ComponentProps<typeof Button>;
}

describe("native rich response choices", () => {
  it("copies the exact follow-up without network requests and confirms success", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const fetch = vi.fn(() => {
      throw new Error("Rich responses must not call a provider");
    });
    vi.stubGlobal("fetch", fetch);
    await act(async () => {
      renderer = create(<RichResponseContent response={response} />);
    });
    await act(async () => {
      choice().onClick?.(
        {} as Parameters<NonNullable<ComponentProps<typeof Button>["onClick"]>>[0],
      );
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith("Explain native rendering.");
    expect(choice().children).toContain("Copied");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("shows an error on clipboard refusal and clears it after a successful retry", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("Clipboard denied"))
      .mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await act(async () => {
      renderer = create(<RichResponseContent response={response} />);
    });
    await act(async () => {
      choice().onClick?.(
        {} as Parameters<NonNullable<ComponentProps<typeof Button>["onClick"]>>[0],
      );
    });
    expect(renderer!.root.findByProps({ role: "alert" }).children).toEqual([
      "Could not copy. Try again.",
    ]);
    expect(choice().children).not.toContain("Copied");
    await act(async () => {
      choice().onClick?.(
        {} as Parameters<NonNullable<ComponentProps<typeof Button>["onClick"]>>[0],
      );
    });
    expect(renderer!.root.findAllByProps({ role: "alert" })).toHaveLength(0);
    expect(choice().children).toContain("Copied");
    expect(writeText).toHaveBeenCalledTimes(2);
  });
});
