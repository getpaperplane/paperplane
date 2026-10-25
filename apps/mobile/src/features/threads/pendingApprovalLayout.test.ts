import { describe, expect, it } from "vite-plus/test";

import { derivePendingApprovalOverlayMaxHeight } from "./pendingApprovalLayout";

describe("derivePendingApprovalOverlayMaxHeight", () => {
  it("keeps the complete dock below the navigation header", () => {
    expect(
      derivePendingApprovalOverlayMaxHeight({
        viewportHeight: 844,
        navigationHeaderHeight: 103,
        keyboardHeight: 0,
        bottomInset: 0,
      }),
    ).toBe(729);
  });

  it("reserves the keyboard and bottom occlusion without reserving either twice", () => {
    expect(
      derivePendingApprovalOverlayMaxHeight({
        viewportHeight: 844,
        navigationHeaderHeight: 103,
        keyboardHeight: 336,
        bottomInset: 24,
      }),
    ).toBe(369);
  });

  it("uses the column viewport rather than the full device height", () => {
    expect(
      derivePendingApprovalOverlayMaxHeight({
        viewportHeight: 480,
        navigationHeaderHeight: 56,
        keyboardHeight: 0,
        bottomInset: 20,
      }),
    ).toBe(392);
  });

  it("does not force a minimum height that would overflow a short viewport", () => {
    const input = {
      viewportHeight: 375,
      navigationHeaderHeight: 44,
      keyboardHeight: 240,
      bottomInset: 0,
    };
    const maxHeight = derivePendingApprovalOverlayMaxHeight(input);
    expect(maxHeight).toBe(79);
    expect(maxHeight + input.navigationHeaderHeight + input.keyboardHeight).toBeLessThan(
      input.viewportHeight,
    );
  });

  it("never produces negative layout dimensions when no space remains", () => {
    expect(
      derivePendingApprovalOverlayMaxHeight({
        viewportHeight: 300,
        navigationHeaderHeight: 103,
        keyboardHeight: 336,
        bottomInset: 0,
      }),
    ).toBe(0);
  });
});
