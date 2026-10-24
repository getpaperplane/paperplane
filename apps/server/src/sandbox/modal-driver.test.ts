import { beforeEach, expect, it, vi } from "vite-plus/test";
import { makeSandboxDriver } from "./drivers.ts";

const sdk = vi.hoisted(() => {
  const app = { appId: "app-test" };
  const image = { imageId: "image-test" };
  return {
    app,
    image,
    apps: { fromName: vi.fn(async () => app) },
    images: { fromRegistry: vi.fn(() => image), fromId: vi.fn(async () => image) },
    sandboxes: { create: vi.fn(async () => ({ sandboxId: "sandbox-test" })) },
    close: vi.fn(),
  };
});
vi.mock("modal", async (importOriginal) => ({
  ...(await importOriginal<typeof import("modal")>()),
  ModalClient: class {
    apps = sdk.apps;
    images = sdk.images;
    sandboxes = sdk.sandboxes;
    close = sdk.close;
  },
}));
beforeEach(() => vi.clearAllMocks());

it("Modal keeps state on the sandbox filesystem, not a volume that rejects hard links", async () => {
  const driver = await makeSandboxDriver("modal", { tokenId: "test-id", token: "test-secret" });
  const handle = await driver.create("task-one");
  expect(handle).toMatchObject({
    remoteId: "sandbox-test",
    volumeName: "paperplane-task-one",
    paused: false,
  });
  expect(sdk.sandboxes.create).toHaveBeenCalledWith(
    sdk.app,
    sdk.image,
    expect.objectContaining({ name: "paperplane-task-one" }),
  );
  expect(sdk.sandboxes.create).toHaveBeenCalledWith(
    sdk.app,
    sdk.image,
    expect.not.objectContaining({ volumes: expect.anything() }),
  );
});

it("Modal recovery restores the latest pause snapshot under the same name", async () => {
  const driver = await makeSandboxDriver("modal", { tokenId: "test-id", token: "test-secret" });
  const handle = await driver.resume({
    remoteId: "old-sandbox",
    url: null,
    snapshotIds: ["older-image", "recovery-image"],
    volumeName: "paperplane-task-one",
    paused: true,
  });
  expect(handle).toMatchObject({
    remoteId: "sandbox-test",
    volumeName: "paperplane-task-one",
    snapshotIds: ["older-image", "recovery-image"],
    paused: false,
  });
  expect(sdk.images.fromId).toHaveBeenCalledWith("recovery-image");
  expect(sdk.sandboxes.create).toHaveBeenCalledWith(
    sdk.app,
    sdk.image,
    expect.objectContaining({ name: "paperplane-task-one" }),
  );
});
