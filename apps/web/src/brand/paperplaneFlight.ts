/**
 * The send moment: a paper plane leaves the composer's send button, flies one
 * smooth curve up to where the new message lands, and the message unfolds
 * from its folded corner.
 *
 * Performance: the flight is a single WAAPI animation of `transform` and
 * `opacity` on one fixed element, so it runs on the compositor and survives a
 * busy main thread while the send is dispatched. The path is sampled from one
 * cubic Bézier so speed and heading never jump between keyframes.
 */

const FLIGHT_MS = 620;
/** The unfold starts as the plane fades, not after it has gone. */
const LANDING_AT = 0.8;
const EASE_OUT = "cubic-bezier(0.23, 1, 0.32, 1)";
const EASE_IN_OUT = "cubic-bezier(0.77, 0, 0.175, 1)";
const PLANE_PATHS =
  '<path d="M2.6 9.6 21.4 4.2 12.6 19.6 10.3 14.4Z"/><path d="M21.4 4.2 7.4 12.3l.9 4.6 2-2.5"/>';

let lastLaunchAt = Number.NEGATIVE_INFINITY;

function prefersReducedMotion(): boolean {
  return (
    typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type Point = { x: number; y: number };

function flightKeyframes(start: Point, end: Point): Keyframe[] {
  // Lift off up and to the left, then glide in from the left onto the corner.
  const rise = Math.max(80, start.y - end.y);
  const c1 = { x: start.x - 70, y: start.y - rise * 0.9 };
  const c2 = { x: end.x - 80, y: end.y - 46 };
  const at = (u: number, k: keyof Point) =>
    (1 - u) ** 3 * start[k] +
    3 * (1 - u) ** 2 * u * c1[k] +
    3 * (1 - u) * u * u * c2[k] +
    u ** 3 * end[k];
  const tangent = (u: number, k: keyof Point) =>
    3 * (1 - u) ** 2 * (c1[k] - start[k]) +
    6 * (1 - u) * u * (c2[k] - c1[k]) +
    3 * u * u * (end[k] - c2[k]);

  const frames: Keyframe[] = [];
  let previous = 0;
  const steps = 48;
  for (let i = 0; i <= steps; i++) {
    const u = i / steps;
    // The icon's nose points 40° above the x-axis; turn it into the direction of travel.
    let angle = (Math.atan2(tangent(u, "y"), tangent(u, "x")) * 180) / Math.PI + 40;
    while (angle - previous > 180) angle -= 360;
    while (angle - previous < -180) angle += 360;
    previous = angle;
    // Bank in from rest rather than snapping to the first heading.
    const heading = u < 0.12 ? angle * (u / 0.12) : angle;
    const scale =
      1 + 0.25 * Math.sin(Math.PI * Math.min(u / 0.8, 1)) - 0.35 * Math.max(0, (u - 0.8) / 0.2);
    frames.push({
      transform: `translate(${at(u, "x") - 11}px, ${at(u, "y") - 11}px) rotate(${heading}deg) scale(${scale})`,
      opacity: u < 0.86 ? 1 : 1 - (u - 0.86) / 0.14,
    });
  }
  return frames;
}

/**
 * Fly a plane from the send button inside `composer` toward the timeline. Call
 * after a send has been dispatched. No-op under reduced motion.
 */
export function launchPaperplaneFlight(composer: HTMLElement | null): void {
  if (!composer || prefersReducedMotion()) return;
  const button = composer.querySelector<HTMLElement>("[data-paperplane-send]");
  if (!button) return;
  const from = button.getBoundingClientRect();
  if (from.width === 0) return;
  const surface = composer.getBoundingClientRect();
  const start = { x: from.left + from.width / 2, y: from.top + from.height / 2 };
  // New messages land right-aligned just above the composer; aim for the
  // folded corner of that bubble.
  const end = { x: surface.right - 12, y: surface.top - 56 };

  const plane = document.createElement("div");
  plane.className = "paperplane-flyer";
  plane.setAttribute("aria-hidden", "true");
  plane.innerHTML = `<svg viewBox="0 0 24 24" width="22" height="22" fill="var(--background)" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round">${PLANE_PATHS}</svg>`;
  document.body.appendChild(plane);
  lastLaunchAt = performance.now();
  plane.animate(flightKeyframes(start, end), {
    duration: FLIGHT_MS,
    easing: EASE_IN_OUT,
    fill: "both",
  }).onfinish = () => plane.remove();

  // The button reloads a fresh plane behind the one that left.
  button.querySelector("svg")?.animate(
    [
      { opacity: 0, transform: "translate(-4px, 4px) scale(0.6)" },
      { opacity: 0, offset: 0.4 },
      { opacity: 1, transform: "none" },
    ],
    { duration: 520, easing: EASE_OUT },
  );
}

/**
 * Unfold a freshly mounted user message from its folded corner when it is the
 * one a plane was just carrying. Returns without animating for history rows.
 */
export function unfoldIfJustSent(bubble: HTMLElement | null): void {
  if (!bubble || prefersReducedMotion()) return;
  const sinceLaunch = performance.now() - lastLaunchAt;
  if (sinceLaunch > FLIGHT_MS * 1.5) return;
  lastLaunchAt = Number.NEGATIVE_INFINITY;
  const delay = Math.max(0, FLIGHT_MS * LANDING_AT - sinceLaunch);
  bubble.animate(
    [
      {
        clipPath:
          "polygon(calc(100% - 14px) 0, calc(100% - 14px) 0, 100% 14px, 100% 14px, 100% 14px)",
        opacity: 0.6,
      },
      {
        clipPath: "polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%)",
        opacity: 1,
      },
    ],
    { duration: 340, delay, easing: EASE_OUT, fill: "backwards" },
  );
}
