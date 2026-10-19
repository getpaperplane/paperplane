import { ComputerDesktopViewerError } from "@rove-code/contracts";
import * as Cause from "effect/Cause";

/**
 * A VM that just booted has no display address for a few seconds, which the
 * server reports as `ComputerDesktopViewerError`. Anything else (authorization,
 * transport) will not heal by waiting, so it fails fast.
 */
export function isViewerRetryable(cause: Cause.Cause<unknown>): boolean {
  return Cause.squash(cause) instanceof ComputerDesktopViewerError;
}
