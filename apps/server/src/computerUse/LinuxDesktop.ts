// @effect-diagnostics nodeBuiltinImport:off -- Podman image hashing and process-scoped container names use synchronous Node crypto.
import * as NodeCrypto from "node:crypto";

import {
  ComputerDesktopViewerError,
  ComputerUseSetupAuthorizationError,
  ThreadId,
} from "@getpaperplane/contracts";
import * as ComputerDesktops from "./ComputerDesktops.ts";
import { Environment as HostProcessEnvironment } from "@getpaperplane/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";

import * as ProcessRunner from "../processRunner.ts";
import { DESKTOP_FILES } from "./LinuxDesktopImage.ts";
import * as LinuxDesktopSetup from "./LinuxDesktopSetup.ts";

export const CAPACITY = 4;
const OWNER_LABEL = "io.paperplane.cua.owner";
const SERVER_LABEL = "io.paperplane.cua.server";
const Identity = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  start: Schema.String.check(Schema.isPattern(/^\d+$/)),
  boot: Schema.String,
  namespace: Schema.String,
});
const decodeIdentity = Schema.decodeUnknownOption(Schema.fromJsonString(Identity));
const encodeIdentity = Schema.encodeSync(Schema.fromJsonString(Identity));
const decodeStart = Schema.decodeUnknownEffect(Identity.fields.start);
const Containers = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      Labels: Schema.Record(Schema.String, Schema.String),
    }),
  ),
);
const decodeContainers = Schema.decodeUnknownEffect(Containers);
const IdMap = Schema.Array(Schema.Struct({ size: Schema.Int }));
const RootlessInfo = Schema.fromJsonString(
  Schema.Struct({
    host: Schema.Struct({
      security: Schema.Struct({ rootless: Schema.Boolean }),
      idMappings: Schema.NullOr(Schema.Struct({ uidmap: IdMap, gidmap: IdMap })),
    }),
  }),
);
const Inspection = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      Id: Schema.String,
      Config: Schema.Struct({ Labels: Schema.Record(Schema.String, Schema.String) }),
      State: Schema.Struct({ Running: Schema.Boolean }),
    }),
  ),
);
const decodeInfo = Schema.decodeUnknownEffect(RootlessInfo);
const decodeInspection = Schema.decodeUnknownEffect(Inspection);

export class LinuxDesktopError extends Schema.TaggedError<LinuxDesktopError>()(
  "LinuxDesktopError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export type Readiness =
  | { readonly kind: "unavailable"; readonly detail: string }
  | { readonly kind: "missing" }
  | { readonly kind: "ready" };

export interface Transport {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

export interface Runtime {
  readonly prepare: (
    authorization?: Redacted.Redacted<string>,
  ) => Effect.Effect<void, LinuxDesktopError | ComputerUseSetupAuthorizationError>;
  readonly check: (executable: string) => Effect.Effect<Readiness>;
  readonly install: (executable: string) => Effect.Effect<void, LinuxDesktopError>;
  readonly connect: <A, E, R>(
    key: string,
    executable: string,
    use: (transport: Transport) => Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | LinuxDesktopError, R>;
  readonly close: (key: string) => Effect.Effect<void, LinuxDesktopError>;
  readonly release: Effect.Effect<void, LinuxDesktopError>;
  readonly count: () => number;
}

const isLinuxDesktopError = Schema.is(LinuxDesktopError);
const error = (detail: string) => new LinuxDesktopError({ detail });

/** The caller serializes connection creation and disposal; a desktop outlives its MCP workers. */
export const make = Effect.fn("LinuxDesktop.make")(function* () {
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const registry = yield* ComputerDesktops.ComputerDesktops;
  const owner = NodeCrypto.randomUUID();
  const desktops = new Map<string, string>();
  const references = new Map<string, { stamp: string; image: string }>();
  let podmanCommand = "podman";
  const run = (args: ReadonlyArray<string>, timeout: Duration.Input = "30 seconds") =>
    runner
      .run({
        command: podmanCommand,
        args: ["--remote=false", ...args],
        env: environment,
        timeout,
      })
      .pipe(Effect.mapError((cause) => error(cause.message)));

  const processStart = Effect.fn("LinuxDesktop.processStart")(function* (pid: number) {
    const stat = yield* fs.readFileString(`/proc/${pid}/stat`);
    return yield* decodeStart(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]).pipe(
      Effect.mapError(() => error("Cannot read the Paperplane process identity.")),
    );
  });
  const identity = yield* Effect.cached(
    Effect.gen(function* () {
      return {
        pid: process.pid,
        start: yield* processStart(process.pid),
        boot: (yield* fs.readFileString("/proc/sys/kernel/random/boot_id")).trim(),
        namespace: yield* fs.readLink("/proc/self/ns/pid"),
      };
    }).pipe(Effect.mapError((cause) => error(cause.message))),
  );
  let reconciled = false;
  const reconcile = Effect.gen(function* () {
    if (reconciled) return;
    const current = yield* identity;
    const output = yield* run([
      "ps",
      "--all",
      "--filter",
      `label=${SERVER_LABEL}`,
      "--format",
      "json",
    ]);
    if (output.code !== 0)
      return yield* error("Cannot enumerate private desktops for crash recovery.");
    const containers = yield* decodeContainers(output.stdout).pipe(
      Effect.mapError(() => error("Podman returned unreadable desktop records.")),
    );
    for (const container of containers) {
      const serverLabel = container.Labels[SERVER_LABEL];
      const previous = decodeIdentity(serverLabel);
      if (Option.isNone(previous) || !container.Labels[OWNER_LABEL]) continue;
      const prior = previous.value;
      let dead = prior.boot !== current.boot;
      if (!dead && prior.namespace === current.namespace) {
        const start = yield* processStart(prior.pid).pipe(Effect.result);
        dead =
          start._tag === "Success"
            ? start.success !== prior.start
            : start.failure._tag === "PlatformError" && start.failure.reason._tag === "NotFound";
      }
      if (!dead) continue;
      const inspected = yield* run(["inspect", container.Id]);
      if (inspected.code !== 0) continue;
      const [record] = yield* decodeInspection(inspected.stdout).pipe(
        Effect.mapError(() => error("Cannot verify orphan desktop ownership.")),
      );
      if (
        !record ||
        record.Id !== container.Id ||
        record.Config.Labels[SERVER_LABEL] !== serverLabel ||
        record.Config.Labels[OWNER_LABEL] !== container.Labels[OWNER_LABEL]
      )
        continue;
      const removed = yield* run(["rm", "--force", record.Id]);
      if (removed.code !== 0) return yield* error("Cannot remove a dead server's private desktop.");
    }
    reconciled = true;
  });

  const requireRootless = Effect.gen(function* () {
    const output = yield* run(["info", "--format", "json"]);
    if (output.code !== 0)
      return yield* error(
        "Rootless Podman is unavailable. Select Install or Retry to set up this Linux host automatically.",
      );
    const info = yield* decodeInfo(output.stdout).pipe(
      Effect.mapError(() => error("Podman returned unreadable runtime information.")),
    );
    if (!info.host.security.rootless)
      return yield* error(
        "Linux computer use requires rootless Podman. Run Paperplane as an unprivileged user.",
      );
    const mappings = info.host.idMappings;
    if (
      mappings === null ||
      !mappings.uidmap.some((mapping) => mapping.size >= 65536) ||
      !mappings.gidmap.some((mapping) => mapping.size >= 65536)
    )
      return yield* error(
        "Rootless user-ID mappings are incomplete. Select Install or Retry to repair Linux setup. Existing Podman containers may need to finish before setup can apply the new mappings.",
      );
  }).pipe(
    Effect.mapError((cause) =>
      error(`Linux headless desktop needs rootless Podman. ${cause.detail}`),
    ),
  );

  const requireCapabilities = Effect.gen(function* () {
    for (const [command, flags] of [
      [
        "run",
        [
          "--env-host",
          "--http-proxy",
          "--read-only",
          "--tmpfs",
          "--memory",
          "--cpus",
          "--pids-limit",
        ],
      ],
      ["build", ["--memory", "--tag", "--file"]],
    ] as const) {
      const help = yield* run([command, "--help"], "10 seconds");
      const missing = flags.filter((flag) => !`${help.stdout}\n${help.stderr}`.includes(flag));
      if (help.code !== 0 || missing.length > 0) {
        const version = yield* run(["--version"]).pipe(Effect.result);
        const installed =
          version._tag === "Success"
            ? (/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/.exec(version.success.stdout)?.[0] ?? "unknown")
            : "unknown";
        return yield* error(
          `Podman ${installed} lacks required private-desktop features (${command}${missing.length ? `: ${missing.join(", ")}` : ""}). This host's package repositories or selected Podman executable may be too old.`,
        );
      }
    }
  });

  const requireKernel = Effect.gen(function* () {
    if (
      !(yield* fs
        .exists("/sys/fs/cgroup/cgroup.controllers")
        .pipe(Effect.mapError(() => error("Cannot inspect Linux cgroups support."))))
    )
      return yield* error(
        "Linux computer use requires cgroups v2 to enforce desktop resource limits. This host's kernel or outer container does not provide it.",
      );
    for (const setting of [
      "/proc/sys/user/max_user_namespaces",
      "/proc/sys/kernel/unprivileged_userns_clone",
    ]) {
      const value = yield* fs.readFileString(setting).pipe(Effect.option);
      if (Option.isSome(value) && value.value.trim() === "0")
        return yield* error(
          "This Linux host's administrator policy disables unprivileged user namespaces. Computer use cannot create a private desktop until the host administrator enables them.",
        );
    }
  });

  const prepare = (authorization?: Redacted.Redacted<string>) =>
    Effect.gen(function* () {
      yield* requireKernel;
      if (yield* fs.exists("/usr/bin/podman").pipe(Effect.orElseSucceed(() => false)))
        podmanCommand = "/usr/bin/podman";
      const ready = yield* requireRootless.pipe(Effect.andThen(requireCapabilities), Effect.result);
      const downloads = yield* runner
        .run({
          command: "/bin/sh",
          args: [
            "-c",
            "command -v bash >/dev/null && command -v curl >/dev/null && command -v tar >/dev/null",
          ],
          env: environment,
        })
        .pipe(Effect.result);
      const libraries = yield* runner
        .run({ command: "/sbin/ldconfig", args: ["-p"], env: environment })
        .pipe(Effect.result);
      const librariesReady =
        libraries._tag === "Success" &&
        libraries.success.code === 0 &&
        ["libXi.so.6", "libxkbcommon.so.0", "libX11.so.6"].every((library) =>
          libraries.success.stdout.includes(library),
        );
      if (
        ready._tag === "Failure" ||
        downloads._tag === "Failure" ||
        downloads.success.code !== 0 ||
        !librariesReady
      ) {
        yield* LinuxDesktopSetup.install(authorization).pipe(
          Effect.mapError((cause) =>
            cause._tag === "ComputerUseSetupAuthorizationError" ? cause : error(cause.message),
          ),
        );
        if (yield* fs.exists("/usr/bin/podman").pipe(Effect.orElseSucceed(() => false)))
          podmanCommand = "/usr/bin/podman";
        const running = yield* run(["ps", "--quiet"]);
        if (running.code !== 0)
          return yield* error("Cannot check running containers after Linux setup.");
        // Podman caches its user namespace. Refresh it only when no user's containers would stop.
        if (running.stdout.trim() === "") {
          const migrated = yield* run(["system", "migrate"]);
          if (migrated.code !== 0)
            return yield* error(
              "Could not apply rootless access after Linux setup. Retry Install.",
            );
        }
        yield* requireRootless;
        yield* requireCapabilities;
      }
      yield* reconcile;
    }).pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, runner),
      Effect.provideService(HostProcessEnvironment, environment),
      Effect.ensuring(
        Effect.sync(() => {
          if (authorization) Redacted.wipeUnsafe(authorization);
        }),
      ),
    );

  const reference = Effect.fn("LinuxDesktop.reference")(
    function* (executable: string) {
      const resolved = yield* fs.realPath(executable);
      const stat = yield* fs.stat(resolved);
      const stamp = `${stat.size}:${Option.getOrUndefined(stat.mtime)?.getTime()}`;
      const cached = references.get(resolved);
      if (cached?.stamp === stamp) return cached.image;
      const binary = yield* fs.readFile(resolved);
      const hash = NodeCrypto.createHash("sha256")
        .update(binary)
        .update(Object.values(DESKTOP_FILES).join("\n"))
        .digest("hex");
      const image = `localhost/paperplane-cua-desktop:${hash.slice(0, 24)}`;
      references.set(resolved, { stamp, image });
      return image;
    },
    Effect.mapError((cause) =>
      error(`Cannot read Cua Driver for the desktop image: ${cause.message}`),
    ),
  );

  const check = Effect.fn("LinuxDesktop.check")(function* (
    executable: string,
  ): Effect.fn.Return<Readiness> {
    const ready = yield* requireRootless.pipe(Effect.andThen(reconcile), Effect.result);
    if (ready._tag === "Failure") return { kind: "unavailable", detail: ready.failure.detail };
    const image = yield* reference(executable).pipe(Effect.result);
    if (image._tag === "Failure") return { kind: "unavailable", detail: image.failure.detail };
    const exists = yield* run(["image", "exists", image.success]).pipe(Effect.result);
    if (exists._tag === "Failure") return { kind: "unavailable", detail: exists.failure.detail };
    if (exists.success.code === 0) return { kind: "ready" };
    if (exists.success.code === 1) return { kind: "missing" };
    return {
      kind: "unavailable",
      detail: `Cannot check the desktop image. ${exists.success.stderr.slice(-1000)}`,
    };
  });

  const install = Effect.fn("LinuxDesktop.install")(
    function* (executable: string) {
      yield* requireRootless;
      yield* reconcile;
      const image = yield* reference(executable);
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-cua-image-" });
      for (const [name, content] of Object.entries(DESKTOP_FILES)) {
        yield* fs.writeFileString(path.join(directory, name), content);
      }
      yield* fs.copyFile(executable, path.join(directory, "cua-driver"));
      const output = yield* run(
        [
          "build",
          "--memory=512m",
          "--tag",
          image,
          "--file",
          path.join(directory, "Containerfile"),
          directory,
        ],
        "10 minutes",
      );
      if (output.code !== 0)
        return yield* error(`Desktop image build failed: ${output.stderr.slice(-2000)}`);
    },
    Effect.scoped,
    Effect.mapError((cause) => (isLinuxDesktopError(cause) ? cause : error(cause.message))),
  );

  const remove = Effect.fn("LinuxDesktop.remove")(function* (name: string) {
    const output = yield* run(["inspect", name]);
    if (output.code !== 0) {
      if (/no such (container|object)/i.test(output.stderr)) return;
      return yield* error(`Cannot inspect owned desktop: ${output.stderr.slice(-1000)}`);
    }
    const [inspection] = yield* decodeInspection(output.stdout).pipe(
      Effect.mapError(() => error("Podman returned unreadable desktop ownership.")),
    );
    if (!inspection || inspection.Config.Labels[OWNER_LABEL] !== owner)
      return yield* error(
        "Desktop ownership does not match this Paperplane server. Nothing was removed.",
      );
    const removed = yield* run(["rm", "--force", inspection.Id]);
    if (removed.code !== 0)
      return yield* error(`Cannot remove owned desktop: ${removed.stderr.slice(-1000)}`);
  });

  const close = Effect.fn("LinuxDesktop.close")(function* (key: string) {
    const name = desktops.get(key);
    if (!name) return;
    yield* remove(name);
    yield* registry.remove(`linux:${key}`);
    desktops.delete(key);
  });

  const connect = <A, E, R>(
    key: string,
    executable: string,
    use: (transport: Transport) => Effect.Effect<A, E, R>,
  ) =>
    Effect.gen(function* () {
      const readiness = yield* check(executable);
      if (readiness.kind === "unavailable") return yield* error(readiness.detail);
      if (readiness.kind === "missing")
        return yield* error(
          "The Linux desktop image is not prepared. Select Install in Settings → Integrations → Computer use.",
        );
      const existing = desktops.get(key);
      if (existing) {
        const output = yield* run(["inspect", existing]);
        if (output.code !== 0)
          return yield* error(
            "The private desktop is no longer available. Use close_desktop to clear this thread's slot before retrying.",
          );
        const [inspection] = yield* decodeInspection(output.stdout).pipe(
          Effect.mapError(() => error("Podman returned unreadable desktop ownership.")),
        );
        if (
          !inspection ||
          inspection.Config.Labels[OWNER_LABEL] !== owner ||
          !inspection.State.Running
        )
          return yield* error(
            "The private desktop is not running with this server's ownership. No input was sent.",
          );
        return yield* use({
          command: podmanCommand,
          args: ["--remote=false", "exec", "--interactive", existing, "/usr/local/bin/mcp.sh"],
        });
      }
      if (
        key !== "control" &&
        [...desktops.keys()].filter((entry) => entry !== "control").length >= CAPACITY
      ) {
        return yield* error(
          `All ${CAPACITY} private desktop slots are occupied. Use close_desktop in a finished thread to discard its temporary apps and files.`,
        );
      }
      const name = `paperplane-cua-${NodeCrypto.randomUUID()}`;
      const image = yield* reference(executable);
      const server = yield* identity;
      desktops.set(key, name);
      const result = yield* use({
        command: podmanCommand,
        args: [
          "--remote=false",
          "run",
          "--interactive",
          "--sig-proxy=false",
          "--name",
          name,
          "--label",
          `${OWNER_LABEL}=${owner}`,
          "--label",
          `${SERVER_LABEL}=${encodeIdentity(server)}`,
          "--network=none",
          "--env-host=false",
          "--http-proxy=false",
          "--ipc=private",
          "--pid=private",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--read-only",
          "--pids-limit=128",
          "--memory=512m",
          "--cpus=1",
          "--tmpfs",
          "/tmp:rw,size=128m,mode=1777",
          image,
        ],
      }).pipe(
        Effect.onError(() =>
          close(key).pipe(Effect.catch((cause) => Effect.logWarning(cause.detail))),
        ),
      );
      if (key.startsWith("thread:")) {
        yield* registry.register(
          `linux:${key}`,
          {
            kind: "linux",
            role: "thread",
            threadId: ThreadId.make(key.slice(7)),
            name: "Linux desktop",
          },
          Effect.gen(function* () {
            const output = yield* run(["inspect", name]);
            const records = yield* decodeInspection(output.stdout).pipe(
              Effect.mapError(() => error("Cannot verify desktop ownership.")),
            );
            const record = records[0];
            if (
              output.code !== 0 ||
              !record ||
              record.Config.Labels[OWNER_LABEL] !== owner ||
              !record.State.Running
            )
              return yield* error("The private desktop is no longer owned and running.");
            return {
              kind: "process" as const,
              password: null,
              transport: {
                command: podmanCommand,
                args: ["--remote=false", "exec", "--interactive", name, "/usr/local/bin/vnc.sh"],
              },
            };
          }).pipe(Effect.mapError(() => new ComputerDesktopViewerError({ desktopId: key }))),
        );
      }
      return result;
    });

  const release = Effect.gen(function* () {
    const failures: Array<string> = [];
    for (const key of desktops.keys()) {
      yield* close(key).pipe(
        Effect.catch((cause) =>
          Effect.sync(() => {
            failures.push(cause.detail);
          }),
        ),
      );
    }
    if (failures.length > 0) return yield* error(failures.join("\n"));
  });
  return {
    prepare,
    check,
    install,
    connect,
    close,
    release,
    count: () => [...desktops.keys()].filter((key) => key !== "control").length,
  } satisfies Runtime;
});
