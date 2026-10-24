import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { SandboxActionInput, SandboxCreateInput } from "@getpaperplane/contracts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { makeSandboxManager } from "./SandboxManager.ts";
import {
  sandboxCredentialsCommand,
  sandboxLabelCommand,
  sandboxPairCommand,
  sandboxStartCommand,
  sandboxStopCommand,
} from "./bootstrap.ts";
import type { SandboxCredentialSource } from "./credentials.ts";
import { makeBoatDriver, type SandboxDriver, type SandboxHandle } from "./drivers.ts";
import { modalOperation, SandboxDriverError } from "./errors.ts";

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
    verify: vi.fn(async () => {}),
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
  const credentials: SandboxCredentialSource = {
    available: vi.fn(async () => ["codex" as const, "github" as const]),
    payload: vi.fn<SandboxCredentialSource["payload"]>(async (kinds) => ({
      files: kinds.map((kind) => ({ path: kind, content: `${kind}-login-secret` })),
      remove: [],
      tools: [],
      git: null,
    })),
  };
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
  const make = makeSandboxManager(factory, credentials).pipe(
    Effect.provide(Layer.merge(Layer.succeed(ServerSecretStore, store), NodeServices.layer)),
  );
  return {
    make,
    driver,
    factory,
    credentials,
    events,
    stored: () => new TextDecoder().decode(bytes),
    corrupt: () => {
      bytes = new TextEncoder().encode("not-json");
    },
  };
}

it.effect("saving BYOK credentials verifies them but never starts cloud compute", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.make;
    yield* manager.configure({ provider: "boat", token: "secret-token" });
    yield* manager.configure({ provider: "modal", token: "modal-secret", tokenId: "modal-id" });
    const inventory = yield* manager.inventory;
    expect(inventory.configuredProviders).toEqual(["boat", "modal"]);
    expect(encodeTestJson(inventory)).not.toContain("secret");
    expect(f.driver.verify).toHaveBeenCalledTimes(2);
    expect(f.driver.create).not.toHaveBeenCalled();
    expect(f.driver.exec).not.toHaveBeenCalled();
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
      // One driver for credential verification, one for creation; both closed.
      expect(f.driver.close).toHaveBeenCalledTimes(2);
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
  "Boat billing diagnostics reach the client and survive manager restart without vendor secrets",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const transport = vi.fn<typeof fetch>().mockImplementation(async (url) =>
        String(url).endsWith("/me")
          ? new Response(encodeTestJson({ ok: true }))
          : new Response(
              encodeTestJson({
                code: "subscription_required",
                message: "secret-token",
                error: { code: "subscription_required", details: { token: "secret-token" } },
              }),
              { status: 402 },
            ),
      );
      f.factory.mockResolvedValue(
        makeBoatDriver({ token: "secret-token", tokenId: "" }, transport),
      );
      const manager = yield* f.make;
      yield* manager.configure({ provider: "boat", token: "secret-token" });
      const error = yield* Effect.flip(
        manager.create({ provider: "boat", label: "Task", confirmCost: true }),
      );
      expect(error.message).toContain("Complete checkout in the Boat dashboard");
      expect(error.message).toContain("HTTP 402");
      const restarted = yield* f.make;
      const inventory = yield* restarted.inventory;
      expect(inventory.sandboxes[0]).toMatchObject({
        phase: "error",
        remoteId: null,
        detail: error.message,
      });
      expect(encodeTestJson(inventory)).not.toContain("secret-token");
      expect(f.driver.exec).not.toHaveBeenCalled();
    }),
);

it.effect(
  "Modal authentication failures reach the client and retain the sandbox name for cleanup",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      f.driver.create = () =>
        modalOperation(async () => {
          throw Object.assign(new Error("secret-token"), { code: 16 });
        });
      const manager = yield* f.make;
      yield* manager.configure({ provider: "modal", token: "secret-token", tokenId: "token-id" });
      const error = yield* Effect.flip(
        manager.create({ provider: "modal", label: "Task", confirmCost: true }),
      );
      expect(error.message).toContain("Check the token ID and secret");
      const inventory = yield* manager.inventory;
      expect(inventory.sandboxes[0]).toMatchObject({
        phase: "error",
        remoteId: null,
        detail: error.message,
      });
      expect(f.stored()).toContain(`rove-${inventory.sandboxes[0]!.id}`);
      expect(encodeTestJson(inventory)).not.toContain("secret-token");
    }),
);

it.effect(
  "safe driver diagnostics also reach lifecycle actions while keeping recovery handles",
  () =>
    Effect.gen(function* () {
      const f = fixture();
      const manager = yield* f.make;
      yield* manager.configure({ provider: "boat", token: "secret" });
      const sandbox = yield* manager.create({ provider: "boat", label: "Task", confirmCost: true });
      f.driver.resume = vi.fn(async () => {
        throw new SandboxDriverError("Boat rejected the API key. Save a new key.");
      });
      const error = yield* Effect.flip(
        manager.action({ id: sandbox.id, action: "resume", confirmed: true }),
      );
      expect(error.message).toBe("Boat rejected the API key. Save a new key.");
      expect((yield* manager.inventory).sandboxes[0]).toMatchObject({
        remoteId: "vm-one",
        phase: "error",
        detail: error.message,
      });
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

it.effect("a failed graceful shutdown refuses snapshot and keeps the sandbox running", () =>
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
    expect((yield* manager.inventory).sandboxes[0]).toMatchObject({
      phase: "running",
      detail: expect.stringContaining("Pause was refused"),
    });
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

it.effect("rejected credentials are not saved", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.driver.verify = vi.fn(async () => {
      throw new SandboxDriverError("Boat rejected the API key.");
    });
    const manager = yield* f.make;
    const error = yield* Effect.flip(manager.configure({ provider: "boat", token: "bad-key" }));
    expect(error.message).toBe("Boat rejected the API key.");
    expect((yield* manager.inventory).configuredProviders).toEqual([]);
    const swapped = yield* Effect.flip(
      manager.configure({ provider: "modal", token: "ak-id", tokenId: "as-secret" }),
    );
    expect(swapped.message).toContain("look swapped");
  }),
);

it.effect("a failed pairing reports the problem without marking a running sandbox failed", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.make;
    yield* manager.configure({ provider: "boat", token: "secret" });
    const sandbox = yield* manager.create({ provider: "boat", label: "Task", confirmCost: true });
    f.driver.exec = vi.fn(async () => "not json");
    yield* Effect.flip(manager.action({ id: sandbox.id, action: "pair", confirmed: true }));
    expect((yield* manager.inventory).sandboxes[0]).toMatchObject({
      phase: "running",
      detail: "Paperplane returned an invalid pairing response.",
    });
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

it.effect("incomplete Modal provisioning retains its sandbox name until explicit cleanup", () =>
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

it.effect("forwarded sign-ins reach the sandbox over stdin before Paperplane starts", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.make;
    yield* manager.configure({ provider: "modal", token: "secret", tokenId: "id" });
    expect((yield* manager.inventory).availableCredentials).toEqual(["codex", "github"]);
    const sandbox = yield* manager.create(
      decodeCreateInput({
        provider: "modal",
        label: "Task",
        confirmCost: true,
        credentials: ["codex"],
        region: "ap",
      }),
    );
    expect(sandbox).toMatchObject({ credentials: ["codex"], region: "ap", detail: null });
    expect(f.driver.create).toHaveBeenCalledWith(sandbox.id, "ap");
    const calls = vi.mocked(f.driver.exec).mock.calls;
    expect(calls.map(([, command]) => command)).toEqual([
      sandboxLabelCommand("Task"),
      sandboxCredentialsCommand,
      sandboxStartCommand,
    ]);
    // Secrets travel on stdin, never in the command line or saved state.
    expect(calls[1]![2]).toContain("codex-login-secret");
    expect(sandboxCredentialsCommand).not.toContain("login-secret");
    expect(f.stored()).not.toContain("login-secret");
  }),
);

it.effect("a failed forward keeps the new sandbox running and explains why", () =>
  Effect.gen(function* () {
    const f = fixture();
    f.credentials.payload = async () => {
      throw new SandboxDriverError("Codex isn't signed in on the managing environment.");
    };
    const manager = yield* f.make;
    yield* manager.configure({ provider: "boat", token: "secret" });
    const sandbox = yield* manager.create(
      decodeCreateInput({
        provider: "boat",
        label: "Task",
        confirmCost: true,
        credentials: ["codex"],
      }),
    );
    expect(sandbox).toMatchObject({
      phase: "running",
      detail: "Codex isn't signed in on the managing environment.",
    });
  }),
);

it.effect("changing sign-ins applies now when running and on resume when paused", () =>
  Effect.gen(function* () {
    const f = fixture();
    const manager = yield* f.make;
    yield* manager.configure({ provider: "boat", token: "secret" });
    const sandbox = yield* manager.create({ provider: "boat", label: "Task", confirmCost: true });
    // Without a selection nothing is forwarded.
    expect(f.credentials.payload).not.toHaveBeenCalled();
    const change = (credentials: ReadonlyArray<"codex" | "github">) =>
      manager.action(
        decodeActionInput({ id: sandbox.id, action: "credentials", confirmed: true, credentials }),
      );
    yield* change(["github"]);
    expect(f.credentials.payload).toHaveBeenLastCalledWith(["github"]);
    yield* manager.action(decodeActionInput({ id: sandbox.id, action: "pause", confirmed: true }));
    vi.mocked(f.credentials.payload).mockClear();
    const paused = yield* change([]);
    expect(paused.sandbox).toMatchObject({ phase: "paused", credentials: [] });
    expect(f.credentials.payload).not.toHaveBeenCalled();
    yield* manager.action(decodeActionInput({ id: sandbox.id, action: "resume", confirmed: true }));
    // Resuming removes the deselected sign-ins before Paperplane restarts.
    expect(f.credentials.payload).toHaveBeenLastCalledWith([]);
  }),
);
