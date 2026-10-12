import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { SandboxActionInput, SandboxCreateInput } from "@rove-code/contracts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { makeSandboxManager } from "./SandboxManager.ts";
import { sandboxPairCommand, sandboxStartCommand, sandboxStopCommand } from "./bootstrap.ts";
import type { SandboxDriver, SandboxHandle } from "./drivers.ts";

const encodeTestJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeCreateInput = Schema.decodeUnknownSync(SandboxCreateInput);
const decodeActionInput = Schema.decodeUnknownSync(SandboxActionInput);

function fixture() {
  let bytes: Uint8Array | undefined;
  const events: string[] = [];
  const handle: SandboxHandle = {
    remoteId: "vm-one",
    url: null,
    snapshotIds: [],
    volumeName: "rove-volume",
    paused: false,
  };
  const driver: SandboxDriver = {
    create: vi.fn(async () => handle),
    resume: vi.fn(async () => ({ ...handle, remoteId: "vm-two" })),
    exec: vi.fn(async (_handle, command) =>
      command === sandboxPairCommand ? JSON.stringify({ credential: "one-time" }) : "",
    ),
    expose: vi.fn(async () => "https://sandbox.example"),
    pause: vi.fn(async (_handle, save) => {
      events.push("snapshot");
      await save("image-one");
      events.push("terminate");
    }),
    remove: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const factory = vi.fn(async () => driver);
  const store = ServerSecretStore.of({
    get: () => Effect.sync(() => (bytes ? Option.some(bytes) : Option.none())),
    set: (_name, value) =>
      Effect.sync(() => {
        bytes = value;
        events.push(`persist:${new TextDecoder().decode(value)}`);
      }),
    create: () => Effect.void,
    remove: () => Effect.void,
    getOrCreateRandom: () => Effect.succeed(new Uint8Array()),
  });
  const make = makeSandboxManager(factory).pipe(
    Effect.provide(Layer.succeed(ServerSecretStore, store)),
    Effect.provide(NodeServices.layer),
  );
  return {
    make,
    driver,
    factory,
    events,
    stored: () => new TextDecoder().decode(bytes),
    corrupt: () => {
      bytes = new TextEncoder().encode("not-json");
    },
  };
}

it.effect(
  "saving BYOK credentials and loading inventory never starts or contacts cloud compute",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const manager = yield* f.make;
      yield* manager.configure({ provider: "boat", token: "secret-token" });
      yield* manager.configure({ provider: "modal", token: "modal-secret", tokenId: "modal-id" });
      const inventory = yield* manager.inventory;
      expect(inventory.configuredProviders).toEqual(["boat", "modal"]);
      expect(encodeTestJson(inventory)).not.toContain("secret");
      expect(f.factory).not.toHaveBeenCalled();
      const reloaded = yield* f.make;
      expect((yield* reloaded.inventory).configuredProviders).toEqual(["boat", "modal"]);
    }),
);

it.effect(
  "creation persists resource identity before bootstrap and never sends an agent prompt",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const manager = yield* f.make;
      yield* manager.configure({ provider: "boat", token: "secret" });
      const sandbox = yield* manager.create({ provider: "boat", label: "Task", confirmCost: true });
      expect(sandbox.phase).toBe("running");
      expect(f.driver.exec).toHaveBeenCalledWith(
        expect.objectContaining({ remoteId: "vm-one" }),
        sandboxStartCommand,
      );
      expect(
        f.events.some(
          (event) => event.includes('"remoteId":"vm-one"') && event.includes('"phase":"creating"'),
        ),
      ).toBe(true);
      expect(sandboxStartCommand).not.toMatch(/boat prompt|claude -p|codex exec/);
      expect(f.driver.close).toHaveBeenCalledOnce();
    }),
);

it.effect(
  "bootstrap failure retains the billable resource for repair, including after manager restart",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.driver.exec = vi.fn(async () => {
        throw new Error("vendor echoed secret-token");
      });
      const manager = yield* f.make;
      yield* manager.configure({ provider: "boat", token: "secret-token" });
      const result = yield* Effect.result(
        manager.create({ provider: "boat", label: "Task", confirmCost: true }),
      );
      expect(result._tag).toBe("Failure");
      const reloaded = yield* f.make;
      const inventory = yield* reloaded.inventory;
      expect(inventory.sandboxes[0]).toMatchObject({ phase: "error", remoteId: "vm-one" });
      expect(encodeTestJson(inventory)).not.toContain("secret-token");
      expect(f.driver.remove).not.toHaveBeenCalled();
    }),
);

it.effect(
  "pause commits the snapshot handle before terminating and resumes the same thread identity",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const manager = yield* f.make;
      yield* manager.configure({ provider: "modal", token: "secret", tokenId: "id" });
      const sandbox = yield* manager.create({
        provider: "modal",
        label: "Task",
        confirmCost: true,
      });
      f.events.length = 0;
      yield* manager.action({ id: sandbox.id, action: "pause", confirmed: true });
      expect(f.driver.exec).toHaveBeenCalledWith(
        expect.objectContaining({ remoteId: "vm-one" }),
        sandboxStopCommand,
      );
      expect(f.events[0]).toBe("snapshot");
      expect(f.events[1]).toContain("image-one");
      expect(f.events[2]).toBe("terminate");
      const resumed = yield* manager.action({ id: sandbox.id, action: "resume", confirmed: true });
      expect(resumed.sandbox).toMatchObject({
        id: sandbox.id,
        remoteId: "vm-two",
        phase: "running",
      });
      expect(f.driver.resume).toHaveBeenCalledWith(
        expect.objectContaining({ snapshotIds: ["image-one"], paused: true }),
      );
    }),
);

it.effect("a failed graceful shutdown refuses snapshot and termination", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.make;
    yield* manager.configure({ provider: "boat", token: "secret" });
    const sandbox = yield* manager.create({ provider: "boat", label: "Task", confirmCost: true });
    f.driver.exec = vi.fn(async () => {
      throw new Error("not stopped");
    });
    yield* Effect.result(manager.action({ id: sandbox.id, action: "pause", confirmed: true }));
    expect(f.driver.pause).not.toHaveBeenCalled();
    expect((yield* manager.inventory).sandboxes[0]?.phase).toBe("error");
  }),
);

it.effect("partial pause failure keeps recovery handles and never reports paused", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.make;
    yield* manager.configure({ provider: "modal", token: "secret", tokenId: "id" });
    const sandbox = yield* manager.create({ provider: "modal", label: "Task", confirmCost: true });
    f.driver.pause = vi.fn(async (_handle, save) => {
      await save("image-recovery");
      throw new Error("termination failed");
    });
    yield* Effect.result(manager.action({ id: sandbox.id, action: "pause", confirmed: true }));
    expect(f.stored()).toContain("image-recovery");
    expect((yield* manager.inventory).sandboxes[0]?.phase).toBe("error");
  }),
);

it.effect("failed deletion keeps the resource and successful retry removes it", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.make;
    yield* manager.configure({ provider: "boat", token: "secret" });
    const sandbox = yield* manager.create({ provider: "boat", label: "Task", confirmCost: true });
    f.driver.remove = vi.fn(async () => {
      throw new Error("deletion failed");
    });
    yield* Effect.result(manager.action({ id: sandbox.id, action: "delete", confirmed: true }));
    expect((yield* manager.inventory).sandboxes).toHaveLength(1);
    f.driver.remove = vi.fn(async () => {});
    yield* manager.action({ id: sandbox.id, action: "delete", confirmed: true });
    expect((yield* manager.inventory).sandboxes).toHaveLength(0);
    yield* manager.configure({ provider: "boat", token: "" });
    expect((yield* manager.inventory).configuredProviders).toHaveLength(0);
  }),
);

it.effect("account replacement is refused while its sandboxes remain tracked", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.make;
    yield* manager.configure({ provider: "boat", token: "original" });
    yield* manager.create({ provider: "boat", label: "Task", confirmCost: true });
    const result = yield* Effect.result(
      manager.configure({ provider: "boat", token: "replacement" }),
    );
    expect(result._tag).toBe("Failure");
    expect(f.stored()).not.toContain("replacement");
  }),
);

it.effect("pairing is one-time, is not persisted, and cannot wake paused compute", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.make;
    yield* manager.configure({ provider: "boat", token: "secret" });
    const sandbox = yield* manager.create({ provider: "boat", label: "Task", confirmCost: true });
    const result = yield* manager.action({ id: sandbox.id, action: "pair", confirmed: true });
    expect(result.pairingUrl).toBe("https://sandbox.example/pair#token=one-time");
    expect(f.stored()).not.toContain("one-time");
    yield* manager.action({ id: sandbox.id, action: "pause", confirmed: true });
    const refused = yield* Effect.result(
      manager.action({ id: sandbox.id, action: "pair", confirmed: true }),
    );
    expect(refused._tag).toBe("Failure");
    expect(f.driver.resume).not.toHaveBeenCalled();
  }),
);

it.effect(
  "a corrupt journal disables sandbox operations without preventing server startup or overwriting it",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.corrupt();
      const manager = yield* f.make;
      expect((yield* Effect.result(manager.inventory))._tag).toBe("Failure");
      expect(
        (yield* Effect.result(manager.configure({ provider: "boat", token: "key" })))._tag,
      ).toBe("Failure");
      expect(f.stored()).toBe("not-json");
      expect(f.factory).not.toHaveBeenCalled();
    }),
);

it.effect("incomplete Modal provisioning retains its named volume until explicit cleanup", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.driver.create = vi.fn(async () => {
      throw new Error("capacity");
    });
    const manager = yield* f.make;
    yield* manager.configure({ provider: "modal", token: "secret", tokenId: "id" });
    yield* Effect.result(manager.create({ provider: "modal", label: "Task", confirmCost: true }));
    const sandbox = (yield* manager.inventory).sandboxes[0]!;
    expect(sandbox).toMatchObject({ remoteId: null, phase: "error" });
    expect(f.stored()).toContain(`rove-${sandbox.id}`);
    yield* manager.action({ id: sandbox.id, action: "delete", confirmed: true });
    expect(f.driver.remove).toHaveBeenCalledWith(
      expect.objectContaining({ remoteId: "", volumeName: `rove-${sandbox.id}` }),
      expect.any(Function),
    );
    expect((yield* manager.inventory).sandboxes).toHaveLength(0);
  }),
);

it.effect("accepted deletion retains its receipt on failure and cannot be resumed", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.make;
    yield* manager.configure({ provider: "boat", token: "secret" });
    const sandbox = yield* manager.create({ provider: "boat", label: "Task", confirmCost: true });
    f.driver.remove = vi.fn(async (_handle, save) => {
      await save("deletion-one");
      throw new Error("pending");
    });
    yield* Effect.result(manager.action({ id: sandbox.id, action: "delete", confirmed: true }));
    expect(f.stored()).toContain("deletion-one");
    expect(encodeTestJson(yield* manager.inventory)).not.toContain("deletion-one");
    expect(
      (yield* Effect.result(manager.action({ id: sandbox.id, action: "resume", confirmed: true })))
        ._tag,
    ).toBe("Failure");
    expect(f.driver.resume).not.toHaveBeenCalled();
    f.driver.remove = vi.fn(async () => {});
    yield* manager.action({ id: sandbox.id, action: "delete", confirmed: true });
    expect(f.driver.remove).toHaveBeenCalledWith(
      expect.objectContaining({ deletionOperationId: "deletion-one" }),
      expect.any(Function),
    );
  }),
);

it.effect(
  "forgetting is explicit local-only recovery for a failed record, never a healthy resource",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const manager = yield* f.make;
      yield* manager.configure({ provider: "boat", token: "original" });
      const sandbox = yield* manager.create({ provider: "boat", label: "Task", confirmCost: true });
      expect(
        (yield* Effect.result(
          manager.action({ id: sandbox.id, action: "forget", confirmed: true }),
        ))._tag,
      ).toBe("Failure");
      f.driver.remove = vi.fn(async () => {
        throw new Error("revoked credentials");
      });
      yield* Effect.result(manager.action({ id: sandbox.id, action: "delete", confirmed: true }));
      f.factory.mockClear();
      yield* manager.action({ id: sandbox.id, action: "forget", confirmed: true });
      expect(f.factory).not.toHaveBeenCalled();
      expect((yield* manager.inventory).sandboxes).toHaveLength(0);
      yield* manager.configure({ provider: "boat", token: "replacement" });
      expect(f.stored()).toContain("replacement");
    }),
);

it("wire contracts require explicit acknowledgement of compute cost and destructive actions", () => {
  expect(() => decodeCreateInput({ provider: "boat", label: "Task" })).toThrow();
  expect(() => decodeActionInput({ id: "one", action: "delete", confirmed: false })).toThrow();
});
