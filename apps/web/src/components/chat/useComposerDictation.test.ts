import { describe, expect, it } from "vite-plus/test";

import { isComposerDictationOffered } from "./useComposerDictation";

describe("isComposerDictationOffered", () => {
  it("is offered for a thread the user can operate when custom text is allowed", () => {
    expect(
      isComposerDictationOffered({
        canOperateThread: true,
        customAnswerAllowed: true,
        dictationBusy: false,
      }),
    ).toBe(true);
  });

  it("is not offered while a choice-only question forbids custom text", () => {
    expect(
      isComposerDictationOffered({
        canOperateThread: true,
        customAnswerAllowed: false,
        dictationBusy: false,
      }),
    ).toBe(false);
  });

  it("stays stoppable while a recording runs even if the question became choice-only", () => {
    expect(
      isComposerDictationOffered({
        canOperateThread: true,
        customAnswerAllowed: false,
        dictationBusy: true,
      }),
    ).toBe(true);
  });

  it("is never offered when the user cannot operate the thread", () => {
    expect(
      isComposerDictationOffered({
        canOperateThread: false,
        customAnswerAllowed: true,
        dictationBusy: true,
      }),
    ).toBe(false);
  });
});
