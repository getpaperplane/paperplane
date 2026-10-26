import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * Fades the timeline in when the displayed thread changes. Renders nothing and
 * animates an element the caller already owns, so the virtualized list keeps
 * its layout. One short opacity animation; skipped under reduced motion.
 */
export function ThreadSwitchFade({
  targetRef,
  threadKey,
}: {
  targetRef: RefObject<HTMLElement | null>;
  threadKey: string;
}) {
  const previousKey = useRef(threadKey);
  useLayoutEffect(() => {
    if (previousKey.current === threadKey) return;
    previousKey.current = threadKey;
    const target = targetRef.current;
    if (!target || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    target.animate([{ opacity: 0.35 }, { opacity: 1 }], {
      duration: 200,
      easing: "cubic-bezier(0.23, 1, 0.32, 1)",
    });
  }, [targetRef, threadKey]);
  return null;
}
