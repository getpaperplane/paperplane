/**
 * Theme changes the user makes reveal the new theme in a circle that grows
 * from where they clicked (or from the centre when chosen by keyboard). It is
 * a single view transition: the browser snapshots the old page once and
 * animates one clip-path, so nothing in the app re-renders per frame.
 * System appearance changes and refreshes skip this and apply instantly.
 */

type RevealTransition = { ready: Promise<void>; finished: Promise<void> };
type RevealDocument = Document & {
  startViewTransition?: (update: () => void) => RevealTransition;
};

const POINTER_FRESH_MS = 1500;
let lastPointer: { x: number; y: number; at: number } | null = null;

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener(
    "pointerdown",
    (event) => {
      lastPointer = { x: event.clientX, y: event.clientY, at: performance.now() };
    },
    { capture: true, passive: true },
  );
}

export function revealThemeChange(update: () => void): void {
  if (typeof document === "undefined" || typeof window === "undefined") {
    update();
    return;
  }
  // SAFETY: startViewTransition is optional on this type and checked before use.
  const revealDocument = document as RevealDocument;
  if (
    !revealDocument.startViewTransition ||
    typeof window.matchMedia !== "function" ||
    document.visibilityState !== "visible" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    update();
    return;
  }

  const pointer =
    lastPointer !== null && performance.now() - lastPointer.at < POINTER_FRESH_MS
      ? lastPointer
      : null;
  const x = pointer?.x ?? window.innerWidth / 2;
  const y = pointer?.y ?? window.innerHeight / 2;
  const radius = Math.hypot(
    Math.max(x, window.innerWidth - x),
    Math.max(y, window.innerHeight - y),
  );
  const root = document.documentElement;
  root.dataset.themeReveal = "true";

  const transition = revealDocument.startViewTransition(update);
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`] },
        {
          duration: 460,
          easing: "cubic-bezier(0.77, 0, 0.175, 1)",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => undefined);
  transition.finished
    .catch(() => undefined)
    .finally(() => {
      delete root.dataset.themeReveal;
    });
}
