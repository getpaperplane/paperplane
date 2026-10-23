import {
  SANDBOX_PORT,
  type RemoteSandbox,
  type SandboxProvider,
  type SandboxRegion,
} from "@rove-code/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { sandboxCommandFailure } from "./bootstrap.ts";
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
  /** Modal only; resumed sandboxes stay in the region they were created in. */
  region?: SandboxRegion;
}
// Bootstrap installs Paperplane and waits for it to become ready; both can be slow.
const COMMAND_TIMEOUT_SECONDS = 600;

export interface SandboxDriver {
  /** Checks the account credentials with a free, read-only request. */
  verify: () => Promise<void>;
  create: (id: string, region?: SandboxRegion) => Promise<SandboxHandle>;
  resume: (handle: SandboxHandle) => Promise<SandboxHandle>;
  pause: (handle: SandboxHandle, saveSnapshot: (id: string) => Promise<void>) => Promise<void>;
  remove: (handle: SandboxHandle, saveDeletion: (id: string) => Promise<void>) => Promise<void>;
  /** `stdin` carries secrets so they never appear in the command line. */
  exec: (handle: SandboxHandle, command: string, stdin?: string) => Promise<string>;
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
const BoatHostResponse = Schema.Struct({ url: Schema.String });
const BoatDeletionResponse = Schema.Struct({
  operation: Schema.Struct({ id: Schema.String, status: Schema.String }),
});

const decodeBoatSandbox = Schema.decodeUnknownSync(BoatSandboxResponse);
const decodeBoatCommand = Schema.decodeUnknownSync(BoatCommandResponse);
const decodeBoatDeletion = Schema.decodeUnknownSync(BoatDeletionResponse);
const decodeBoatHost = Schema.decodeUnknownSync(BoatHostResponse);

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
      signal: AbortSignal.timeout(
        method === "GET" ? 15_000 : (COMMAND_TIMEOUT_SECONDS + 30) * 1000,
      ),
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
  const exec = async (handle: SandboxHandle, command: string, stdin?: string) => {
    await ready(handle);
    // Boat's command API has no stdin; the payload travels in the HTTPS body
    // to Boat, the same trust boundary as the sandbox itself.
    const piped =
      stdin === undefined
        ? command
        : `printf %s ${Buffer.from(stdin).toString("base64")} | base64 -d | ${command}`;
    const result = decodeBoatCommand(
      await request(`${path(handle)}/commands`, {
        command: piped,
        timeoutSeconds: COMMAND_TIMEOUT_SECONDS,
      }),
    );
    if (!result.success || result.exitCode !== 0)
      throw new SandboxDriverError(
        (result.exitCode === null ? undefined : sandboxCommandFailure(result.exitCode)) ??
          "Sandbox command failed. Inspect the sandbox in Boat for details.",
      );
    return result.stdout;
  };
  return {
    verify: async () => {
      await request("/me");
    },
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
      await ready(handle);
      // Boat's proxy token isn't compatible with Paperplane's pairing/WebSocket URLs.
      // Paperplane's own authentication, not an ungated agent endpoint, owns access.
      const result = decodeBoatHost(
        await request(`${path(handle)}/host`, { port: SANDBOX_PORT, public: true }),
      );
      const url = new URL(result.url);
      if (url.protocol !== "https:")
        throw new SandboxDriverError(
          "Boat did not return a hosted URL. Check the sandbox's hosted ports in the Boat dashboard, then resume to repair it.",
        );
      return url.origin;
    },
    close: () => {},
  };
}

// The gRPC SDK is loaded only for an explicit Modal lifecycle operation, not at startup.
export const makeSandboxDriver: SandboxDriverFactory = async (provider, credentials) => {
  if (provider === "boat") return makeBoatDriver(credentials);
  const { ModalClient, NotFoundError } = await import("modal");
  const client = new ModalClient({ tokenId: credentials.tokenId, tokenSecret: credentials.token });
  // State lives on the sandbox filesystem and persists through pause snapshots,
  // as Modal recommends for work beyond its 24-hour run limit. Modal volumes
  // can't hold it: they reject hard links, which npm and Paperplane's atomic writes need.
  // `name` (stored as volumeName for older records) finds unrecorded sandboxes.
  const create = async (
    name: string,
    region: SandboxRegion | undefined,
    snapshotId?: string,
  ): Promise<SandboxHandle> => {
    const app = await client.apps.fromName("rove-thread-sandboxes", { createIfMissing: true });
    const image = snapshotId
      ? await client.images.fromId(snapshotId)
      : client.images.fromRegistry("node:24-bookworm");
    const sandbox = await client.sandboxes.create(app, image, {
      cpu: 2,
      cpuLimit: 2,
      memoryMiB: 8192,
      memoryLimitMiB: 8192,
      runtime: "vm",
      timeoutMs: 24 * 60 * 60 * 1000,
      encryptedPorts: [SANDBOX_PORT],
      name,
      ...(region ? { regions: [region] } : {}),
    });
    return {
      remoteId: sandbox.sandboxId,
      url: null,
      snapshotIds: [],
      volumeName: name,
      paused: false,
      ...(region ? { region } : {}),
    };
  };
  const driver: SandboxDriver = {
    verify: async () => {
      await client.apps.fromName("rove-thread-sandboxes", { createIfMissing: true });
    },
    create: (id, region) => create(`rove-${id}`, region),
    resume: async (handle) => {
      if (!handle.paused) {
        try {
          const sandbox = await client.sandboxes.fromId(handle.remoteId);
          if ((await sandbox.poll()) === null) return handle;
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
        }
      }
      return {
        ...(await create(
          handle.volumeName ?? `rove-${handle.remoteId}`,
          handle.region,
          handle.snapshotIds.at(-1),
        )),
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
      // Older sandboxes kept their home on a volume of the same name.
      if (handle.volumeName) await client.volumes.delete(handle.volumeName, { allowMissing: true });
    },
    exec: async (handle, command, stdin) => {
      const sandbox = await client.sandboxes.fromId(handle.remoteId);
      const process = await sandbox.exec(["bash", "-lc", command], {
        timeoutMs: COMMAND_TIMEOUT_SECONDS * 1000,
      });
      if (stdin !== undefined) {
        await process.stdin.writeText(stdin);
        await process.stdin.close();
      }
      const [stdout, , exitCode] = await Promise.all([
        process.stdout.readText(),
        process.stderr.readText(),
        process.wait(),
      ]);
      if (exitCode !== 0)
        throw new SandboxDriverError(
          sandboxCommandFailure(exitCode) ??
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
    verify: () => modalOperation(() => driver.verify()),
    create: (id, region) => modalOperation(() => driver.create(id, region)),
    resume: (handle) => modalOperation(() => driver.resume(handle)),
    pause: (handle, save) => modalOperation(() => driver.pause(handle, save)),
    remove: (handle, save) => modalOperation(() => driver.remove(handle, save)),
    exec: (handle, command, stdin) => modalOperation(() => driver.exec(handle, command, stdin)),
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
    ...(record.region ? { region: record.region } : {}),
  };
  return record.deletionOperationId
    ? { ...handle, deletionOperationId: record.deletionOperationId }
    : handle;
}
