import { expect, it } from "vite-plus/test";
import {
  InvalidError,
  NotFoundError,
  ResourceExhaustedError,
  SnapshotCreationError,
  TimeoutError,
} from "modal";
import { modalOperation, SandboxDriverError } from "./errors.ts";

it.each([
  [3, "sandbox configuration"],
  [4, "timed out"],
  [5, "recovery resource"],
  [7, "workspace permissions"],
  [8, "resource or quota limit"],
  [9, "current state"],
  [14, "Could not reach Modal"],
  [16, "Check the token ID and secret"],
] as const)(
  "Modal gRPC %i explains the failure without exposing server details",
  async (code, message) => {
    const result = modalOperation(async () => {
      throw Object.assign(new Error("secret-token"), { code, details: "secret-token" });
    });
    await expect(result).rejects.toThrow(message);
    await expect(result).rejects.toThrow(`gRPC ${code}`);
    await expect(result).rejects.not.toThrow("secret-token");
  },
);

it.each([
  [new ResourceExhaustedError("secret-token"), "resource or quota limit"],
  [new TimeoutError("secret-token"), "timed out"],
  [new InvalidError("secret-token"), "sandbox configuration"],
  [new NotFoundError("secret-token"), "recovery resource"],
  [new SnapshotCreationError("secret-token"), "recovery snapshot"],
])("Modal SDK errors explain recovery without exposing the SDK message", async (error, message) => {
  const result = modalOperation(async () => {
    throw error;
  });
  await expect(result).rejects.toThrow(message);
  await expect(result).rejects.not.toThrow("secret-token");
});

it("unrecognized Modal failures fall back to the manager's operation-specific error", async () => {
  const error = new Error("unrecognized secret-token");
  await expect(
    modalOperation(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});

it("known product-owned Modal diagnostics are preserved", async () => {
  const error = new SandboxDriverError("Modal did not return a tunnel URL.");
  await expect(
    modalOperation(async () => {
      throw error;
    }),
  ).rejects.toBe(error);
});
