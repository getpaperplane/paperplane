import {
  ComputerDesktopViewerError,
  EnvironmentAuthorizationError,
} from "@getpaperplane/contracts";
import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { isViewerRetryable } from "./desktop-viewer-retry";

describe("isViewerRetryable", () => {
  it("retries a desktop that is not viewable yet", () => {
    expect(isViewerRetryable(Cause.fail(new ComputerDesktopViewerError({ desktopId: "d" })))).toBe(
      true,
    );
  });

  it("fails fast on authorization failures and defects", () => {
    expect(
      isViewerRetryable(
        Cause.fail(
          new EnvironmentAuthorizationError({ message: "no", requiredScope: "terminal:read" }),
        ),
      ),
    ).toBe(false);
    expect(isViewerRetryable(Cause.die(new Error("boom")))).toBe(false);
  });
});
