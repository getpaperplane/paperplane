import type { SVGProps } from "react";

/**
 * Paperplane brand marks, drawn on the 24px icon grid so they sit beside lucide
 * icons at the same stroke weight. Colours come from `currentColor` and the
 * active theme, so every theme wears them.
 */

/** The app icon's plane as a line icon. The nose points 40° above the x-axis. */
export function PaperPlaneIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M2.6 9.6 21.4 4.2 12.6 19.6 10.3 14.4Z" />
      <path d="M21.4 4.2 7.4 12.3l.9 4.6 2-2.5" />
    </svg>
  );
}

/**
 * A plane trailing a dashed flight path: the "working" status. Static on
 * purpose: the sidebar can hold many working rows, and a looping icon in each
 * would repaint every frame.
 */
export function InFlightIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 28 16"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M1.5 13.5c3.5 0 6-3.6 9.2-4.6" strokeWidth={1.25} strokeDasharray="1.5 2.5" />
      <g transform="translate(9.5 -2.6) scale(0.85)" strokeWidth={1.75}>
        <path d="M2.6 9.6 21.4 4.2 12.6 19.6 10.3 14.4Z" />
        <path d="M21.4 4.2 7.4 12.3l.9 4.6 2-2.5" />
      </g>
    </svg>
  );
}

/** A cancellation postmark: double ring and three waves. Decorative only. */
export function PostmarkMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 92 70"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      aria-hidden="true"
      {...props}
    >
      <circle cx="30" cy="35" r="24" />
      <circle cx="30" cy="35" r="18" />
      <path d="M58 22c6-4 10 4 16 0s10 4 16 0M58 35c6-4 10 4 16 0s10 4 16 0M58 48c6-4 10 4 16 0s10 4 16 0" />
    </svg>
  );
}

/**
 * The sidebar header as a sheet folded once: a diagonal crease and a small
 * plane at the end of a dashed flight path. Shown when no release-channel
 * artwork owns the header.
 */
export function SidebarCrease() {
  return (
    <div aria-hidden className="paperplane-crease pointer-events-none absolute inset-0 z-0">
      <svg className="paperplane-crease-trail" viewBox="0 0 120 40" fill="none">
        <path
          d="M4 34C30 34 46 10 76 16S98 20 102 12"
          stroke="currentColor"
          strokeWidth={1}
          strokeDasharray="2 3"
          strokeLinecap="round"
          opacity={0.7}
        />
        <g
          transform="translate(100 3) rotate(8)"
          stroke="currentColor"
          strokeWidth={1.1}
          strokeLinejoin="round"
        >
          <path d="M0 6 14 2 7 13 5.5 9Z" fill="var(--sidebar)" />
          <path d="M14 2 3.5 7.6l.7 3.4 1.3-2" />
        </g>
      </svg>
    </div>
  );
}
