import { SANDBOX_PORT, type RemoteSandbox, type SandboxProvider } from "@rove-code/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { boatRequestError, modalOperation, SandboxDriverError } from "./errors.ts";

export const SandboxCredentials = Schema.Struct({ token: Schema.String, tokenId: Schema.String });
export type SandboxCredentials = typeof SandboxCredentials.Type;
export interface SandboxHandle {
  remoteId: string;
  url: string | null;
  snapshotIds: ReadonlyArray<string>;
  volumeName: string | null;
  paused: boolean;
  deletionOperationId?: string;
}
export interface SandboxDriver {
  create: (id: string) => Promise<SandboxHandle>;
  resume: (handle: SandboxHandle) => Promise<SandboxHandle>;
  pause: (handle: SandboxHandle, saveSnapshot: (id: string) => Promise<void>) => Promise<void>;
  remove: (handle: SandboxHandle, saveDeletion: (id: string) => Promise<void>) => Promise<void>;
  exec: (handle: SandboxHandle, command: string) => Promise<string>;
  expose: (handle: SandboxHandle) => Promise<string>;
  close: () => void;
}
export type SandboxDriverFactory = (
  provider: SandboxProvider,
  credentials: SandboxCredentials,
) => Promise<SandboxDriver>;

const BoatSandboxResponse = Schema.Struct({
  sandbox: Schema.Struct({ id: Schema.String, state: Schema.String }),
});
const BoatCommandResponse = Schema.Struct({
  success: Schema.Boolean,
  exitCode: Schema.NullOr(Schema.Int),
  stdout: Schema.String,
});
const BoatDeletionResponse = Schema.Struct({
  operation: Schema.Struct({ id: Schema.String, status: Schema.String }),
});

const decodeBoatSandbox = Schema.decodeUnknownSync(BoatSandboxResponse);
const decodeBoatCommand = Schema.decodeUnknownSync(BoatCommandResponse);
const decodeBoatDeletion = Schema.decodeUnknownSync(BoatDeletionResponse);

export function makeBoatDriver(
  credentials: SandboxCredentials,
  transport: typeof fetch = fetch,
): SandboxDriver {
  const request = async (
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
    idempotencyKey?: string,
  ) => {
    const headers = new Headers({
      Authorization: `Bearer ${credentials.token}`,
      "Content-Type": "application/json",
    });
    if (idempotencyKey) headers.set("Idempotency-Key", idempotencyKey);
    if (method === "DELETE")
      headers.set("X-Ascii-Confirm-Delete", decodeURIComponent(path.split("/").at(-1) ?? ""));
    const response = await transport(`https://boat.dev/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? null : JSON.stringify(body),
      signal: AbortSignal.timeout(method === "GET" ? 15_000 : 200_000),
    }).catch((error: unknown) => {
      const timedOut =
        error instanceof Error && ["TimeoutError", "AbortError"].includes(error.name);
      throw new SandboxDriverError(
        timedOut
          ? "The Boat request timed out. Check the Boat dashboard for existing resources before retrying."
          : "Could not reach Boat. Check the managing environment's internet connection and the Boat dashboard before retrying.",
      );
    });
    if (!response.ok)
      throw boatRequestError(response.status, await response.json().catch(() => null));
    return response.status === 204 ? null : await response.json();
  };
  const path = (handle: SandboxHandle) => `/sandboxes/${encodeURIComponent(handle.remoteId)}`;
  const ready = async (handle: SandboxHandle) => {
    const deadline = performance.now() + 120_000;
    for (let attempt = 0; attempt < 120 && performance.now() < deadline; attempt++) {
      const result = decodeBoatSandbox(await request(path(handle)));
      if (["ready", "idle", "running"].includes(result.sandbox.state)) return;
      if (["error", "archived", "stopped", "cancelled"].includes(result.sandbox.state))
        throw new SandboxDriverError(
          "The Boat sandbox is not running. Resume it before trying again.",
        );
      await Effect.runPromise(Effect.sleep("1 second"));
    }
    throw new SandboxDriverError(
      "The Boat sandbox did not become ready within two minutes. Check its state in the Boat dashboard before resuming or deleting it.",
    );
  };
  const exec = async (handle: SandboxHandle, command: string) => {
    await ready(handle);
    const result = decodeBoatCommand(
      await request(`${path(handle)}/commands`, { command, timeoutSeconds: 180 }),
    );
    if (!result.success || result.exitCode !== 0)
      throw new SandboxDriverError(
        "Sandbox command failed. Inspect the sandbox in Boat for details.",
      );
    return result.stdout;
  };
  return {
    create: async (id) => {
      const result = decodeBoatSandbox(
        await request("/sandboxes", { type: "default", noEnv: true, ttlSeconds: null }, "POST", id),
      );
      return {
        remoteId: result.sandbox.id,
        url: null,
        snapshotIds: [],
        volumeName: null,
        paused: false,
      };
    },
    resume: async (handle) => {
      const result = decodeBoatSandbox(await request(path(handle)));
      if (!["ready", "idle", "running"].includes(result.sandbox.state))
        await request(`${path(handle)}/resume`, { ttlSeconds: null });
      return { ...handle, paused: false };
    },
    pause: async (handle) => {
      await request(`${path(handle)}/stop`, {});
      const deadline = performance.now() + 120_000;
      for (let attempt = 0; attempt < 120 && performance.now() < deadline; attempt++) {
        const result = decodeBoatSandbox(await request(path(handle)));
        if (["archived", "stopped"].includes(result.sandbox.state)) return;
        await Effect.runPromise(Effect.sleep("1 second"));
      }
      throw new SandboxDriverError(
        "Boat stop is still pending; inspect its snapshot status before retrying.",
      );
    },
    remove: async (handle, saveDeletion) => {
      const id =
        handle.deletionOperationId ??
        decodeBoatDeletion(await request(path(handle), undefined, "DELETE")).operation.id;
      // Deletion is asynchronous. Persist its receipt before polling so retries
      // don't mistake a hidden/deleting sandbox for completed cleanup.
      await saveDeletion(id);
      const deadline = performance.now() + 120_000;
      for (let attempt = 0; attempt < 120 && performance.now() < deadline; attempt++) {
        const result = decodeBoatDeletion(
          await request(`/deletion-operations/${encodeURIComponent(id)}`),
        );
        if (result.operation.status === "completed") return;
        if (result.operation.status === "blocked")
          throw new SandboxDriverError("Boat deletion is blocked; inspect the Boat dashboard.");
        await Effect.runPromise(Effect.sleep("1 second"));
      }
      throw new SandboxDriverError(
        "Boat deletion remains pending. Its operation receipt was retained for retry.",
      );
    },
    exec,
    expose: async (handle) => {
      // The Boat proxy token isn't compatible with Rove's pairing/WebSocket
      // URLs. Rove's own authentication, not an ungated agent endpoint, owns access.
      const output = await exec(handle, `host ${SANDBOX_PORT} --public`);
      const url = output.match(/https:\/\/[a-zA-Z0-9-]+\.on\.boat\.dev/u)?.[0];
      if (!url)
        throw new SandboxDriverError(
          "Boat did not return a hosted URL. Check the sandbox's hosted ports in the Boat dashboard, then resume to repair it.",
        );
      return url;
    },
    close: () => {},
  };
}

// Modal does not allow volume mounts at /root. Keep HOME on the dedicated
// volume so bootstrap, provider credentials and workspaces persist together.
const MODAL_HOME = "/rove-home";

// The gRPC SDK is loaded only for an explicit Modal lifecycle operation, not at startup.
export const makeSandboxDriver: SandboxDriverFactory = async (provider, credentials) => {
  if (provider === "boat") return makeBoatDriver(credentials);
  const { ModalClient, NotFoundError } = await import("modal");
  const client = new ModalClient({ tokenId: credentials.tokenId, tokenSecret: credentials.token });
  const create = async (volumeName: string, snapshotId?: string): Promise<SandboxHandle> => {
    const app = await client.apps.fromName("rove-thread-sandboxes", { createIfMissing: true });
    const image = snapshotId
      ? await client.images.fromId(snapshotId)
      : client.images.fromRegistry("node:24-bookworm");
    const volume = await client.volumes.fromName(volumeName, { createIfMissing: true });
    const sandbox = await client.sandboxes.create(app, image, {
      cpu: 2,
      cpuLimit: 2,
      memoryMiB: 8192,
      memoryLimitMiB: 8192,
      runtime: "vm",
      timeoutMs: 24 * 60 * 60 * 1000,
      encryptedPorts: [SANDBOX_PORT],
      env: { HOME: MODAL_HOME },
      // Thread state survives the 24-hour compute limit even without a manual
      // filesystem snapshot. This volume is deleted only by explicit deletion.
      volumes: { [MODAL_HOME]: volume },
      name: volumeName,
    });
    return { remoteId: sandbox.sandboxId, url: null, snapshotIds: [], volumeName, paused: false };
  };
  const driver: SandboxDriver = {
    create: (id) => create(`rove-${id}`),
    resume: async (handle) => {
      if (!handle.paused) {
        try {
          const sandbox = await client.sandboxes.fromId(handle.remoteId);
          if ((await sandbox.poll()) === null) return handle;
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      if (!handle.volumeName)
        throw new SandboxDriverError(
          "The Modal recovery volume is missing. Check the Modal dashboard before deleting this record; its files cannot be restored without the volume.",
        );
      return {
        ...(await create(handle.volumeName, handle.snapshotIds.at(-1))),
        snapshotIds: handle.snapshotIds,
      };
    },
    pause: async (handle, saveSnapshot) => {
      const sandbox = await client.sandboxes.fromId(handle.remoteId);
      const image = await sandbox.snapshotFilesystem({ ttlMs: null, timeoutMs: 180_000 });
      // Persist the recovery handle BEFORE terminating compute. If persistence fails,
      // leave the sandbox intact; never trade an acknowledged pause for lost work.
      await saveSnapshot(image.imageId);
      await sandbox.terminate({ wait: true });
    },
    remove: async (handle) => {
      try {
        const sandbox = handle.remoteId
          ? await client.sandboxes.fromId(handle.remoteId)
          : await client.sandboxes.fromName("rove-thread-sandboxes", handle.volumeName ?? "");
        await sandbox.terminate({ wait: true });
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error;
      }
      for (const id of handle.snapshotIds) {
        try {
          await client.images.delete(id);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      if (handle.volumeName) await client.volumes.delete(handle.volumeName, { allowMissing: true });
    },
    exec: async (handle, command) => {
      const sandbox = await client.sandboxes.fromId(handle.remoteId);
      const process = await sandbox.exec(["bash", "-lc", command], { timeoutMs: 180_000 });
      const [stdout, , exitCode] = await Promise.all([
        process.stdout.readText(),
        process.stderr.readText(),
        process.wait(),
      ]);
      if (exitCode !== 0)
        throw new SandboxDriverError(
          "Sandbox command failed. Inspect the sandbox in Modal for details.",
        );
      return stdout;
    },
    expose: async (handle) => {
      const sandbox = await client.sandboxes.fromId(handle.remoteId);
      const tunnel = (await sandbox.tunnels())[SANDBOX_PORT];
      if (!tunnel)
        throw new SandboxDriverError(
          "Modal did not return a tunnel URL. Check the sandbox in the Modal dashboard, then resume to repair it.",
        );
      return tunnel.url;
    },
    close: () => client.close(),
  };
  return {
    ...driver,
    create: (id) => modalOperation(() => driver.create(id)),
    resume: (handle) => modalOperation(() => driver.resume(handle)),
    pause: (handle, save) => modalOperation(() => driver.pause(handle, save)),
    remove: (handle, save) => modalOperation(() => driver.remove(handle, save)),
    exec: (handle, command) => modalOperation(() => driver.exec(handle, command)),
    expose: (handle) => modalOperation(() => driver.expose(handle)),
  };
};

export function sandboxHandle(
  record: RemoteSandbox & {
    snapshotIds: ReadonlyArray<string>;
    volumeName: string | null;
    deletionOperationId?: string;
  },
): SandboxHandle {
  if (!record.remoteId)
    throw new Error(
      "Provisioning did not return a sandbox ID. Check the vendor dashboard before retrying.",
    );
  const handle = {
    remoteId: record.remoteId,
    url: record.url,
    snapshotIds: record.snapshotIds,
    volumeName: record.volumeName,
    paused: record.phase === "paused",
  };
  return record.deletionOperationId
    ? { ...handle, deletionOperationId: record.deletionOperationId }
    : handle;
}
