import type { SVGProps } from "react";

// Shared with the DOM context-menu renderer, which cannot render React components.
export const POTATO_ICON_PATHS = [
  "M19.5 4.5c3 3 1.8 7.5-1.2 11.2-3.2 4-8.1 6.4-11.6 3.8C3 16.8 2.5 12.4 5.1 8.5c2.8-4.2 10.7-7.7 14.4-4Z",
  "m8 10 .5-.5M14 7l.5.5M14 15l.5-.5M8 16l.5.5",
] as const;

export function PotatoIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {POTATO_ICON_PATHS.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}
