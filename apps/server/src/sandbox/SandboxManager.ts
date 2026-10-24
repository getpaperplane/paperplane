// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import {
  RemoteSandbox,
  SandboxError,
  type SandboxCredentialKind,
  type SandboxProvider,
  SandboxActionInput,
  SandboxActionResult,
  SandboxConfigureInput,
  SandboxCreateInput,
  SandboxInventory,
  SandboxLinkInput,
} from "@getpaperplane/contracts";
import {
  Environment as HostProcessEnvironment,
  Platform as HostProcessPlatform,
} from "@getpaperplane/shared/HostProcess";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  sandboxCredentialsCommand,
  sandboxLabelCommand,
  sandboxPairCommand,
  sandboxStartCommand,
  sandboxStopCommand,
} from "./bootstrap.ts";
import { makeLocalSandboxCredentials, type SandboxCredentialSource } from "./credentials.ts";
import { SandboxDriverError } from "./errors.ts";
import {
  makeSandboxDriver,
  sandboxHandle,
  SandboxCredentials,
  type SandboxDriver,
  type SandboxDriverFactory,
  type SandboxHandle,
} from "./drivers.ts";

const StoredSandbox = Schema.Struct({
  ...RemoteSandbox.fields,
  snapshotIds: Schema.Array(Schema.String),
  volumeName: Schema.NullOr(Schema.String),
  deletionOperationId: Schema.optionalKey(Schema.String),
});
const StoredState = Schema.Struct({
  credentials: Schema.Struct({
    boat: Schema.optionalKey(SandboxCredentials),
    modal: Schema.optionalKey(SandboxCredentials),
  }),
  sandboxes: Schema.Array(StoredSandbox),
});
const decodePairingOutput = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ credential: Schema.String })),
);
const StateJson = Schema.fromJsonString(StoredState);
const decodeStateJson = Schema.decodeUnknownEffect(StateJson);
const encodeStateJson = Schema.encodeEffect(StateJson);
const KEY = "remote-sandboxes";
const providerName = (provider: SandboxProvider) => (provider === "boat" ? "Boat" : "Modal");
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class SandboxManager extends Context.Service<
  SandboxManager,
  {
    inventory: Effect.Effect<typeof SandboxInventory.Type, SandboxError>;
    configure: (input: typeof SandboxConfigureInput.Type) => Effect.Effect<void, SandboxError>;
    create: (input: typeof SandboxCreateInput.Type) => Effect.Effect<RemoteSandbox, SandboxError>;
    action: (
      input: typeof SandboxActionInput.Type,
    ) => Effect.Effect<typeof SandboxActionResult.Type, SandboxError>;
    link: (input: typeof SandboxLinkInput.Type) => Effect.Effect<void, SandboxError>;
  }
>()("@getpaperplane/server/sandbox/SandboxManager") {
  static readonly layer: Layer.Layer<SandboxManager, never, ServerSecretStore | Crypto.Crypto> =
    Layer.effect(
      SandboxManager,
      Effect.suspend(() => makeSandboxManager()),
    );
}

export const makeSandboxManager = Effect.fn("SandboxManager.make")(function* (
  factory: SandboxDriverFactory = makeSandboxDriver,
  credentials?: SandboxCredentialSource,
) {
  const store = yield* ServerSecretStore;
  const credentialSource =
    credentials ??
    makeLocalSandboxCredentials({
      env: yield* HostProcessEnvironment,
      home: NodeOS.homedir(),
      platform: yield* HostProcessPlatform,
    });
  const crypto = yield* Crypto.Crypto;
  const semaphore = yield* Semaphore.make(1);
  const emptyState: typeof StoredState.Type = { credentials: {}, sandboxes: [] };
  const loaded = yield* Effect.gen(function* () {
    const saved = yield* store
      .get(KEY)
      .pipe(
        Effect.mapError(
          () => new SandboxError({ message: "Could not read sandbox configuration." }),
        ),
      );
    return Option.isSome(saved)
      ? yield* decodeStateJson(textDecoder.decode(saved.value)).pipe(
          Effect.mapError(
            () =>
              new SandboxError({
                message: "Sandbox configuration is invalid; it was not overwritten.",
              }),
          ),
        )
      : emptyState;
  }).pipe(
    Effect.match({
      onFailure: (error) => ({ state: emptyState, error }),
      onSuccess: (state) => ({ state, error: null }),
    }),
  );
  // A damaged optional-feature journal must not take the whole environment
  // offline. Refuse all sandbox operations without discarding recovery handles.
  let state = loaded.state;
  const save = (next: typeof StoredState.Type) =>
    encodeStateJson(next).pipe(
      Effect.flatMap((json) => store.set(KEY, textEncoder.encode(json))),
      Effect.mapError(
        () =>
          new SandboxError({
            message:
              "Could not persist sandbox state. Check saved recovery handles before retrying.",
          }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          state = next;
        }),
      ),
    );
  const publicRecord = (record: typeof StoredSandbox.Type): RemoteSandbox => {
    const {
      snapshotIds: _snapshots,
      volumeName: _volume,
      deletionOperationId: _deletion,
      ...result
    } = record;
    return result;
  };
  // Settings polls inventory during long operations; detection runs `gh` and
  // `security`, so reuse a recent answer.
  let detected: { at: number; kinds: ReadonlyArray<SandboxCredentialKind> } | null = null;
  const availableCredentials = Effect.promise(async () => {
    if (detected && performance.now() - detected.at < 30_000) return detected.kinds;
    const kinds = await credentialSource.available();
    detected = { at: performance.now(), kinds };
    return kinds;
  });
  const inventory = loaded.error
    ? Effect.fail(loaded.error)
    : availableCredentials.pipe(
        Effect.map((available) => ({
          configuredProviders: (["boat", "modal"] as const).filter(
            (provider) => state.credentials[provider] !== undefined,
          ),
          sandboxes: state.sandboxes.map(publicRecord),
          availableCredentials: available,
        })),
      );
  const replace = (record: typeof StoredSandbox.Type) =>
    save({
      ...state,
      sandboxes: state.sandboxes.map((value) => (value.id === record.id ? record : value)),
    });
  const serial = <A>(effect: Effect.Effect<A, SandboxError>) =>
    loaded.error
      ? Effect.fail(loaded.error)
      : semaphore.withPermit(effect).pipe(Effect.uninterruptible);
  const withCredentials = <A>(
    provider: SandboxProvider,
    credentials: SandboxCredentials,
    use: (driver: Awaited<ReturnType<SandboxDriverFactory>>) => Effect.Effect<A, SandboxError>,
  ) =>
    Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () => factory(provider, credentials),
        catch: () =>
          new SandboxError({
            message: `Could not initialize ${providerName(provider)}. Check its credentials.`,
          }),
      }),
      use,
      (driver) => Effect.sync(() => driver.close()),
    );
  const withDriver = <A>(
    provider: SandboxProvider,
    use: (driver: Awaited<ReturnType<SandboxDriverFactory>>) => Effect.Effect<A, SandboxError>,
  ) => {
    const credentials = state.credentials[provider];
    if (!credentials)
      return Effect.fail(
        new SandboxError({ message: `Configure ${providerName(provider)} credentials first.` }),
      );
    return withCredentials(provider, credentials, use);
  };
  // Drivers may surface product-owned diagnostics, never raw vendor errors.
  // Keep the resource handle available for repair regardless of the error.
  const operation = <A>(run: () => Promise<A>, message: string) =>
    Effect.tryPromise({
      try: run,
      catch: (error) =>
        new SandboxError({
          message: error instanceof SandboxDriverError ? error.message : message,
        }),
    });
  // Copies fresh sign-ins from this environment, and removes deselected ones,
  // before Paperplane (re)starts so its provider probes see the tools and logins.
  const forwardCredentials = (
    driver: SandboxDriver,
    handle: SandboxHandle,
    kinds: ReadonlyArray<SandboxCredentialKind>,
  ) =>
    operation(async () => {
      const payload = await credentialSource.payload(kinds);
      await driver.exec(handle, sandboxCredentialsCommand, JSON.stringify(payload));
    }, "Could not forward sign-ins to the sandbox. Change a sign-in under Remote sandboxes to retry.");
  const nameEnvironment = (driver: SandboxDriver, handle: SandboxHandle, label: string) =>
    Effect.ignore(operation(() => driver.exec(handle, sandboxLabelCommand(label)), ""));
  // A failed forward shouldn't strand a sandbox that is otherwise healthy and
  // billing; record the reason and keep going.
  const forwardOnStart = (
    driver: SandboxDriver,
    handle: SandboxHandle,
    record: typeof StoredSandbox.Type,
  ) =>
    record.credentials === undefined
      ? Effect.succeed<string | null>(null)
      : forwardCredentials(driver, handle, record.credentials).pipe(
          Effect.as<string | null>(null),
          Effect.catch((error) => Effect.succeed<string | null>(error.message)),
        );

  const configure = Effect.fn("SandboxManager.configure")(function* (
    input: typeof SandboxConfigureInput.Type,
  ) {
    if (state.sandboxes.some((record) => record.provider === input.provider))
      return yield* new SandboxError({
        message:
          "Delete this provider's tracked sandboxes before changing its account credentials.",
      });
    const token = input.token.trim();
    const tokenId = input.tokenId?.trim() ?? "";
    if (input.provider === "modal" && token && !tokenId)
      return yield* new SandboxError({
        message: "Modal requires both a token ID and token secret.",
      });
    if (input.provider === "modal" && tokenId.startsWith("as-") && token.startsWith("ak-"))
      return yield* new SandboxError({
        message:
          "The Modal token ID and secret look swapped. The ID starts with ak- and the secret with as-.",
      });
    const credentials = { ...state.credentials };
    if (token) {
      // Saving verifies the account so a bad key surfaces now, not after a
      // user has confirmed billed compute.
      yield* withCredentials(input.provider, { token, tokenId }, (driver) =>
        operation(
          () => driver.verify(),
          `Could not verify the ${providerName(input.provider)} credentials. Check them and your internet connection, then try again.`,
        ),
      );
      credentials[input.provider] = { token, tokenId };
    } else delete credentials[input.provider];
    yield* save({ ...state, credentials });
  });
  const create = Effect.fn("SandboxManager.create")(function* (
    input: typeof SandboxCreateInput.Type,
  ) {
    return yield* withDriver(input.provider, (driver) =>
      Effect.gen(function* () {
        const id = yield* crypto
          .randomUUIDv4()
          .pipe(
            Effect.mapError(
              () => new SandboxError({ message: "Could not generate a sandbox identity." }),
            ),
          );
        let record: typeof StoredSandbox.Type = {
          id,
          provider: input.provider,
          label: input.label,
          phase: "creating",
          remoteId: null,
          url: null,
          detail: null,
          environmentId: null,
          threadId: null,
          snapshotIds: [],
          volumeName: input.provider === "modal" ? `rove-${id}` : null,
          ...(input.credentials?.length ? { credentials: input.credentials } : {}),
          ...(input.provider === "modal" && input.region ? { region: input.region } : {}),
        };
        yield* save({ ...state, sandboxes: [...state.sandboxes, record] });
        return yield* Effect.gen(function* () {
          const handle = yield* operation(
            () => driver.create(record.id, record.region),
            "Provisioning failed. Check the vendor dashboard for resources before retrying.",
          );
          record = {
            ...record,
            remoteId: handle.remoteId,
            snapshotIds: handle.snapshotIds,
            volumeName: handle.volumeName,
          };
          yield* replace(record);
          yield* nameEnvironment(driver, handle, record.label);
          const forwardError = yield* forwardOnStart(driver, handle, record);
          yield* operation(
            () => driver.exec(handle, sandboxStartCommand),
            "Paperplane setup failed. The sandbox may still be billing; resume to repair or delete it.",
          );
          const url = yield* operation(
            () => driver.expose(handle),
            "Could not expose Paperplane. The sandbox may still be billing; resume to repair or delete it.",
          );
          record = { ...record, phase: "running", url, detail: forwardError };
          yield* replace(record);
          return publicRecord(record);
        }).pipe(
          Effect.catch((error) =>
            replace({ ...record, phase: "error", detail: error.message }).pipe(
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );
      }),
    );
  });
  const action = Effect.fn("SandboxManager.action")(function* (
    input: typeof SandboxActionInput.Type,
  ) {
    const record = state.sandboxes.find((value) => value.id === input.id);
    if (!record) return yield* new SandboxError({ message: "Sandbox not found." });
    if (input.action === "forget") {
      if (record.phase !== "error" && record.phase !== "deleting")
        return yield* new SandboxError({
          message:
            "Only a failed resource can be forgotten. Pause or delete healthy sandboxes instead.",
        });
      yield* save({
        ...state,
        sandboxes: state.sandboxes.filter((value) => value.id !== input.id),
      });
      return { sandbox: null, pairingUrl: null };
    }
    if (!record.remoteId) {
      if (input.action !== "delete")
        return yield* new SandboxError({
          message:
            "Provisioning returned no resource ID. Check the vendor dashboard before retrying.",
        });
      if (record.provider === "modal" && record.volumeName) {
        yield* withDriver(record.provider, (driver) =>
          operation(
            () =>
              driver.remove(
                {
                  remoteId: "",
                  url: null,
                  snapshotIds: record.snapshotIds,
                  volumeName: record.volumeName,
                  paused: false,
                },
                async () => {},
              ),
            "Cleanup of incomplete Modal provisioning failed. Check the vendor dashboard and retry.",
          ),
        );
      }
      // Explicit deletion acknowledges that unknown Boat resources must be
      // checked separately. Never automatically hide a failed allocation.
      yield* save({
        ...state,
        sandboxes: state.sandboxes.filter((value) => value.id !== input.id),
      });
      return { sandbox: null, pairingUrl: null };
    }
    if (record.deletionOperationId && input.action !== "delete")
      return yield* new SandboxError({
        message:
          "Deletion has been accepted by the vendor. Retry deletion to check its completion; this sandbox cannot be resumed.",
      });
    const selected = record;
    return yield* withDriver(record.provider, (driver) =>
      Effect.gen(function* () {
        let current = selected;
        // Failures that leave the remote server untouched keep the sandbox's
        // phase, so a refused pause or failed pairing doesn't hide Connect.
        let untouched =
          input.action === "pair" || input.action === "pause" || input.action === "credentials";
        return yield* Effect.gen(function* () {
          let pairingUrl: string | null = null;
          const handle = sandboxHandle(current);
          if (input.action === "resume") {
            const resumed = yield* operation(
              () => driver.resume(handle),
              "Resume failed. The sandbox may still be billing; check the vendor dashboard.",
            );
            current = {
              ...current,
              remoteId: resumed.remoteId,
              phase: "creating",
              url: null,
              detail: null,
            };
            yield* replace(current);
            yield* nameEnvironment(driver, resumed, current.label);
            const forwardError = yield* forwardOnStart(driver, resumed, current);
            yield* operation(
              () => driver.exec(resumed, sandboxStartCommand),
              "Paperplane restart failed. Resume again to repair, or delete the sandbox.",
            );
            const url = yield* operation(
              () => driver.expose(resumed),
              "Could not expose the resumed Paperplane server.",
            );
            current = { ...current, url, phase: "running", detail: forwardError };
          } else if (input.action === "credentials") {
            const kinds = input.credentials;
            if (!kinds)
              return yield* new SandboxError({ message: "Choose which sign-ins to forward." });
            // A paused sandbox applies the new selection when it resumes.
            if (current.phase === "running") yield* forwardCredentials(driver, handle, kinds);
            current = { ...current, credentials: kinds, detail: null };
          } else if (input.action === "pause") {
            if (current.phase === "paused") return { sandbox: publicRecord(current), pairingUrl };
            yield* operation(
              () => driver.exec(handle, sandboxStopCommand),
              "Paperplane did not shut down cleanly. Pause was refused to protect its data.",
            );
            untouched = false;
            // Snapshot handles must commit before the driver terminates compute.
            const saveSnapshot = (id: string) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  current = { ...current, snapshotIds: [...current.snapshotIds, id] };
                  yield* replace(current);
                }),
              );
            yield* operation(
              () => driver.pause(handle, saveSnapshot),
              "Pause failed. Recovery data was retained; resume to repair or check the vendor dashboard.",
            );
            current = { ...current, phase: "paused", url: null, detail: null };
          } else if (input.action === "delete") {
            current = { ...current, phase: "deleting" };
            yield* replace(current);
            const saveDeletion = (id: string) =>
              Effect.runPromise(
                Effect.gen(function* () {
                  current = { ...current, deletionOperationId: id };
                  yield* replace(current);
                }),
              );
            yield* operation(
              () => driver.remove(handle, saveDeletion),
              "Deletion did not complete. The record and recovery handles were retained; retry deletion.",
            );
            yield* save({
              ...state,
              sandboxes: state.sandboxes.filter((value) => value.id !== current.id),
            });
            return { sandbox: null, pairingUrl };
          } else {
            if (current.phase !== "running" || !current.url)
              return yield* new SandboxError({ message: "Resume the sandbox before connecting." });
            const output = yield* operation(
              () => driver.exec(handle, sandboxPairCommand),
              "Could not issue a pairing credential.",
            );
            const credential = yield* decodePairingOutput(output).pipe(
              Effect.mapError(
                () => new SandboxError({ message: "Paperplane returned an invalid pairing response." }),
              ),
            );
            const url = new URL("/pair", current.url);
            url.hash = new URLSearchParams({ token: credential.credential }).toString();
            pairingUrl = url.toString();
            current = { ...current, detail: null };
          }
          yield* replace(current);
          return { sandbox: publicRecord(current), pairingUrl };
        }).pipe(
          Effect.catch((error) =>
            replace({
              ...current,
              phase: untouched ? current.phase : "error",
              detail: error.message,
            }).pipe(Effect.andThen(Effect.fail(error))),
          ),
        );
      }),
    );
  });
  const link = Effect.fn("SandboxManager.link")(function* (input: typeof SandboxLinkInput.Type) {
    const record = state.sandboxes.find((value) => value.id === input.id);
    if (!record) return yield* new SandboxError({ message: "Sandbox not found." });
    if (
      record.threadId !== null &&
      (record.threadId !== input.threadId || record.environmentId !== input.environmentId)
    )
      return yield* new SandboxError({
        message: "This sandbox already belongs to a different thread.",
      });
    yield* replace({ ...record, environmentId: input.environmentId, threadId: input.threadId });
  });
  return SandboxManager.of({
    inventory,
    configure: (input) => serial(configure(input)),
    create: (input) => serial(create(input)),
    action: (input) => serial(action(input)),
    link: (input) => serial(link(input)),
  });
});
