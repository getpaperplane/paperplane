/** Keeps the approval dock below navigation and above the keyboard and bottom occlusions. */
export function derivePendingApprovalOverlayMaxHeight(input: {
  readonly viewportHeight: number;
  readonly navigationHeaderHeight: number;
  readonly keyboardHeight: number;
  readonly bottomInset: number;
}): number {
  return Math.max(
    0,
    input.viewportHeight -
      Math.max(0, input.navigationHeaderHeight) -
      Math.max(0, input.keyboardHeight) -
      Math.max(0, input.bottomInset) -
      12,
  );
}
