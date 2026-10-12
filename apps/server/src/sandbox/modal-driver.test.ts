import { beforeEach, expect, it, vi } from "vite-plus/test";
import { makeSandboxDriver } from "./drivers.ts";

const sdk = vi.hoisted(() => {
  const app = { appId: "app-test" };
  const image = { imageId: "image-test" };
  const volume = { volumeId: "volume-test" };
  return {
    app,
    image,
    volume,
    apps: { fromName: vi.fn(async () => app) },
    images: { fromRegistry: vi.fn(() => image), fromId: vi.fn(async () => image) },
    volumes: { fromName: vi.fn(async () => volume) },
    sandboxes: { create: vi.fn(async () => ({ sandboxId: "sandbox-test" })) },
    close: vi.fn(),
  };
});
vi.mock("modal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("modal")>()),
  ModalClient: class {
    apps = sdk.apps;
    images = sdk.images;
    volumes = sdk.volumes;
    sandboxes = sdk.sandboxes;
    close = sdk.close;
  },
}));
beforeEach(() => vi.clearAllMocks());

it("Modal places HOME and persistent state on an allowed dedicated volume, not /root", async () => {
  const driver = await makeSandboxDriver("modal", { tokenId: "test-id", token: "test-secret" });
  const handle = await driver.create("task-one");
  expect(handle).toMatchObject({
    remoteId: "sandbox-test",
    volumeName: "rove-task-one",
    paused: false,
  });
  expect(sdk.sandboxes.create).toHaveBeenCalledWith(
    sdk.app,
    sdk.image,
    expect.objectContaining({
      env: { HOME: "/rove-home" },
      volumes: { "/rove-home": sdk.volume },
      name: "rove-task-one",
    }),
  );
});

it("Modal recovery remounts the same persistent home while retaining snapshots", async () => {
  const driver = await makeSandboxDriver("modal", { tokenId: "test-id", token: "test-secret" });
  const handle = await driver.resume({
    remoteId: "old-sandbox",
    url: null,
    snapshotIds: ["recovery-image"],
    volumeName: "rove-task-one",
    paused: true,
  });
  expect(handle).toMatchObject({
    remoteId: "sandbox-test",
    volumeName: "rove-task-one",
    snapshotIds: ["recovery-image"],
    paused: false,
  });
  expect(sdk.images.fromId).toHaveBeenCalledWith("recovery-image");
  expect(sdk.volumes.fromName).toHaveBeenCalledWith("rove-task-one", { createIfMissing: true });
  expect(sdk.sandboxes.create).toHaveBeenCalledWith(
    sdk.app,
    sdk.image,
    expect.objectContaining({
      env: { HOME: "/rove-home" },
      volumes: { "/rove-home": sdk.volume },
    }),
  );
});
