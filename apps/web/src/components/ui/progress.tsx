import { cn } from "~/lib/utils";

/**
 * A determinate progress bar. The fill scales on the compositor and only moves when `value`
 * changes; there is no indeterminate animation, so show text instead when progress is unknown.
 */
export function Progress({
  value,
  label,
  size = "default",
  className,
}: {
  /** 0-100. */
  readonly value: number;
  readonly label: string;
  readonly size?: "default" | "thin";
  readonly className?: string;
}) {
  const clamped = Math.min(100, Math.max(0, value));
  return (
    <div
      aria-label={label}
      aria-valuemax={100}
      aria-valuemin={0}
      aria-valuenow={Math.floor(clamped)}
      className={cn(
        "shrink-0 overflow-hidden rounded-full bg-foreground/10",
        size === "thin" ? "h-0.5" : "h-1",
        className,
      )}
      data-slot="progress"
      role="progressbar"
    >
      <div
        className="h-full origin-left bg-primary transition-transform duration-300 ease-out motion-reduce:transition-none"
        style={{ transform: `scaleX(${clamped / 100})` }}
      />
    </div>
  );
}
