// @effect-diagnostics nodeBuiltinImport:off -- Validate Lume IPs, strip terminal escapes and identify this server's ownership record.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodeUtil from "node:util";

import {
  ComputerDesktopViewerError,
  ThreadId,
  type ComputerUseMacosVm,
} from "@rove-code/contracts";
import * as ComputerDesktops from "./ComputerDesktops.ts";
import {
  Environment as HostProcessEnvironment,
  Platform as HostProcessPlatform,
} from "@rove-code/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import type { Transport } from "./LinuxDesktop.ts";

// Apple permits two concurrent macOS guests TOTAL, including guests outside Rove.
// Reserve only one working slot; Lume enforces the host-wide limit at boot.
const CAPACITY = 1;
const GOLDEN = "rove-cua-golden";
const WORK = "rove-cua-work-1";
const DRIVER = "/Users/lume/.local/bin/cua-driver";
const IMAGE = "macos-tahoe-cua:26.5.2";
// Official MIT-licensed Lume installer. The Homebrew tap still points at an old release.
// https://github.com/trycua/cua/blob/main/LICENSING.md
const INSTALL_COMMAND = '/bin/bash -c "$(curl -fsSL https://cua.ai/lume/install.sh)"';
const INSTALL_SCRIPT =
  'script="$(curl -fsSL https://cua.ai/lume/install.sh)" && /bin/bash -c "$script"';
const REQUIRED_DISK = 150_000_000_000;
const Vm = Schema.Struct({
  name: Schema.String,
  status: Schema.String,
  ipAddress: Schema.optionalKey(Schema.NullOr(Schema.String)),
  vncUrl: Schema.optionalKey(Schema.NullOr(Schema.String)),
  diskSize: Schema.optionalKey(Schema.Struct({ allocated: Schema.Number, total: Schema.Number })),
  memorySize: Schema.optionalKey(Schema.Number),
});
const decodeVms = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Vm)));
const Owner = Schema.Struct({
  pid: Schema.Int.check(Schema.isGreaterThan(0)),
  start: Schema.String.check(Schema.isMinLength(1)),
  token: Schema.String,
  work: Schema.Boolean,
  preparing: Schema.Boolean,
});
const decodeOwner = Schema.decodeUnknownEffect(Schema.fromJsonString(Owner));
const encodeOwner = Schema.encodeSync(Schema.fromJsonString(Owner));
const decodeConsent = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      accessibility: Schema.Literal(true),
      screen_recording: Schema.Literal(true),
      source: Schema.Struct({ attribution: Schema.Literal("driver-daemon") }),
    }),
  ),
);

/** Parse complete Lume output lines. Chunk framing and UTF-8 decoding stay at the stream boundary. */
export const parseLumeProgress = (line: string) => {
  const text = NodeUtil.stripVTControlCharacters(line);
  const percentMatch = /(?:^|\s)(\d{1,3})%/.exec(text);
  const percent = percentMatch ? Math.min(100, Number(percentMatch[1])) : undefined;
  const eta = /ETA:\s*(\d+(?::\d{2}){1,2})(?![\d:])/.exec(text)?.[1];
  const etaSeconds = eta?.split(":").reduce((total, part) => total * 60 + Number(part), 0);
  if (/Decompressing|Reassembling|Copying OCI image/i.test(text) || percent === 100)
    return { phase: "unpacking" as const, ...(percent !== undefined ? { percent } : {}) };
  if (percent === undefined) return undefined;
  return {
    phase: "downloading" as const,
    percent,
    ...(etaSeconds !== undefined ? { etaSeconds } : {}),
  };
};

export class MacosVmError extends Schema.TaggedError<MacosVmError>()("MacosVmError", {
  reason: Schema.Literals([
    "unavailable",
    "missing-lume",
    "runtime",
    "ownership",
    "consent",
    "capacity",
    "not-ready",
    "preparing",
    "display",
    "disk",
  ]),
  cause: Schema.optionalKey(Schema.Defect()),
  /** Free bytes measured when `reason` is "disk". */
  freeBytes: Schema.optionalKey(Schema.Number),
}) {
  override get message(): string {
    switch (this.reason) {
      case "unavailable":
        return "Isolated macOS desktops require an Apple Silicon Mac.";
      case "missing-lume":
        return "Lume is missing. Install it from Settings → Integrations → Computer use.";
      case "ownership":
        return "Another Rove server owns these VMs, or ownership cannot be verified. Nothing was removed.";
      case "consent":
        return "The VM hasn't granted Accessibility and Screen Recording yet. Open setup desktop in Settings, approve the prompts (or use Type setup command in its Terminal), then verify again.";
      case "capacity":
        return "The private macOS VM slot is occupied. Use close_desktop in the finished thread or Release VM in Settings. Rove never evicts work or falls back to the host.";
      case "preparing":
        return "The macOS VM is still being prepared. Wait for it to finish or cancel it in Settings.";
      case "not-ready":
        return "Prepare and verify the isolated macOS desktop in Settings before using it. No host input was sent.";
      case "display":
        return "Couldn't open the VM display. The VM didn't start or Lume didn't report a local VNC address. Try again, or remove the VM and prepare it again.";
      case "disk":
        return this.freeBytes === undefined
          ? "Not enough free disk space for the macOS VM. Free up space, then try again."
          : `Not enough free disk space for the macOS VM. It needs about ${Math.round(REQUIRED_DISK / 1e9)} GB; ${(this.freeBytes / 1e9).toFixed(1)} GB is free. Free up space, then try again.`;
      case "runtime":
        return "The Lume VM operation failed. Check Lume, available disk/RAM and Apple's two-guest host limit. No host input was sent.";
    }
  }
}

export class MacosVm extends Context.Service<
  MacosVm,
  {
    readonly check: Effect.Effect<ComputerUseMacosVm>;
    readonly install: Effect.Effect<void, MacosVmError>;
    readonly prepare: Effect.Effect<void, MacosVmError>;
    readonly cancel: Effect.Effect<void, MacosVmError>;
    readonly verify: Effect.Effect<void, MacosVmError>;
    readonly openDisplay: Effect.Effect<void, MacosVmError>;
    readonly lease: (key: string) => Effect.Effect<Transport, MacosVmError>;
    readonly close: (key: string) => Effect.Effect<void, MacosVmError>;
    readonly release: Effect.Effect<void, MacosVmError>;
    readonly remove: Effect.Effect<void, MacosVmError>;
  }
>()("@rove-code/server/computerUse/MacosVm") {}

/** CuaDriver serializes this runtime with its transport lock. Idle MCP retirement does not close leases. */
export const make = Effect.fn("MacosVm.make")(function* (options?: { readonly arch?: string }) {
  const scope = yield* Effect.scope;
  const registry = yield* ComputerDesktops.ComputerDesktops;
  const runner = yield* ProcessRunner.ProcessRunner;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const environment = yield* HostProcessEnvironment;
  const platform = yield* HostProcessPlatform;
  const config = yield* ServerConfig.ServerConfig;
  const directory = path.join(config.stateDir, "computer-use", "macos");
  const storage = path.join(directory, "vms");
  const keyPath = path.join(directory, "id_ed25519");
  const ownerPath = path.join(directory, "owner.json");
  const sealedPath = path.join(directory, "sealed");
  const token = NodeCrypto.randomUUID();
  let owned = false;
  let preparing = false;
  let leaseKey: string | undefined;
  let workOwned = false;
  let executable: string | undefined;
  let preparation: Fiber.Fiber<void> | undefined;
  let progress: ComputerUseMacosVm["progress"];
  let lastError: string | undefined;
  let lumeVersion: string | undefined;
  let freeDiskBytes: number | undefined;
  const wrap = (cause: unknown) =>
    Schema.is(MacosVmError)(cause) ? cause : new MacosVmError({ reason: "runtime", cause });
  const supported = platform === "darwin" && (options?.arch ?? process.arch) === "arm64";
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    timeout: Duration.Input = "30 seconds",
  ) =>
    runner.run({ command, args, env: environment, timeout }).pipe(
      // Spawn failures can retain argv, including boot credentials. Do not propagate them.
      Effect.mapError(() => new MacosVmError({ reason: "runtime" })),
    );
  const checked = Effect.fn("MacosVm.checked")(function* (
    command: string,
    args: ReadonlyArray<string>,
    timeout?: Duration.Input,
  ) {
    const output = yield* run(command, args, timeout);
    if (output.code !== 0) return yield* new MacosVmError({ reason: "runtime" });
    return output.stdout;
  });
  /** Free bytes on the VM storage volume, or undefined when `df` can't be read. */
  const measureFreeDisk = Effect.gen(function* () {
    const df = yield* run("/bin/df", ["-kP", storage]).pipe(Effect.option);
    const free =
      Option.isSome(df) && df.value.code === 0
        ? Number(df.value.stdout.trim().split("\n").at(-1)?.trim().split(/\s+/)[3]) * 1024
        : NaN;
    return Number.isFinite(free) ? free : undefined;
  });
  const discover = Effect.gen(function* () {
    if (!supported) return yield* new MacosVmError({ reason: "unavailable" });
    const home = environment.HOME ?? NodeOS.homedir();
    const candidates = [
      ...(environment.PATH ?? "")
        .split(":")
        .filter(Boolean)
        .map((p) => path.join(p, "lume")),
      path.join(home, ".local", "bin", "lume"),
      "/opt/homebrew/bin/lume",
    ];
    for (const candidate of new Set(candidates)) {
      if (!(yield* fs.exists(candidate))) continue;
      const version = yield* run(candidate, ["--version"]).pipe(Effect.option);
      if (Option.isSome(version) && version.value.code === 0) {
        executable = candidate;
        lumeVersion = version.value.stdout.trim().slice(0, 100);
        return lumeVersion;
      }
    }
    return yield* new MacosVmError({ reason: "missing-lume" });
  }).pipe(Effect.mapError(wrap));
  const lume = (args: ReadonlyArray<string>, timeout?: Duration.Input) =>
    checked(executable ?? "lume", args, timeout);
  const list = Effect.gen(function* () {
    const output = yield* lume(["ls", "--storage", storage, "--format", "json"]);
    return yield* decodeVms(output).pipe(
      Effect.mapError(() => new MacosVmError({ reason: "runtime" })),
    );
  });
  const get = Effect.fn("MacosVm.get")(function* (name: string) {
    const output = yield* lume(["get", name, "--storage", storage, "--format", "json"]);
    const records = yield* decodeVms(output).pipe(
      Effect.mapError(() => new MacosVmError({ reason: "runtime" })),
    );
    const record = records.find((vm) => vm.name === name);
    if (!record) return yield* new MacosVmError({ reason: "runtime" });
    return record;
  });
  const stop = Effect.fn("MacosVm.stop")(function* (name: string) {
    const vm = (yield* list).find((entry) => entry.name === name);
    yield* registry.remove(`vm:${name}`);
    if (vm && vm.status !== "stopped") yield* lume(["stop", name, "--storage", storage]);
  });
  const discard = Effect.fn("MacosVm.discard")(function* (name: string) {
    if (name !== WORK && name !== GOLDEN) return yield* new MacosVmError({ reason: "ownership" });
    if (!(yield* list).some((vm) => vm.name === name)) return;
    yield* stop(name);
    yield* lume(["delete", name, "--storage", storage, "--force"]);
  });
  const identity = yield* Effect.cached(
    checked("/bin/ps", ["-p", String(process.pid), "-o", "lstart="]),
  );
  const assertOwner = Effect.gen(function* () {
    const owner = yield* fs.readFileString(ownerPath).pipe(
      Effect.flatMap(decodeOwner),
      Effect.mapError((cause) => new MacosVmError({ reason: "ownership", cause })),
    );
    if (!owned || owner.token !== token) return yield* new MacosVmError({ reason: "ownership" });
  });
  const saveOwner = Effect.gen(function* () {
    yield* assertOwner;
    const temporary = path.join(directory, `owner-${token}.tmp`);
    yield* fs.writeFileString(
      temporary,
      encodeOwner({ pid: process.pid, start: yield* identity, token, work: workOwned, preparing }),
      { mode: 0o600 },
    );
    yield* fs.rename(temporary, ownerPath);
  }).pipe(Effect.mapError(wrap));
  // A PID plus its start time avoids deleting guests after PID reuse. Unverifiable owners fail closed.
  const claim = Effect.gen(function* () {
    if (owned) return yield* assertOwner;
    if (!executable) yield* discover;
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    yield* fs.makeDirectory(storage, { recursive: true });
    let crashed = false;
    let orphanWork = false;
    let orphanGolden = false;
    if (yield* fs.exists(ownerPath)) {
      const prior = yield* fs.readFileString(ownerPath).pipe(
        Effect.flatMap(decodeOwner),
        Effect.mapError((cause) => new MacosVmError({ reason: "ownership", cause })),
      );
      const previous = yield* run("/bin/ps", ["-p", String(prior.pid), "-o", "lstart="]);
      if (
        previous.code !== 1 &&
        (previous.code !== 0 || !previous.stdout.trim() || previous.stdout === prior.start)
      )
        return yield* new MacosVmError({ reason: "ownership" });
      yield* fs.remove(ownerPath);
      orphanWork = prior.work;
      orphanGolden = prior.preparing;
      crashed = true;
    }
    yield* fs
      .writeFileString(
        ownerPath,
        encodeOwner({
          pid: process.pid,
          start: yield* identity,
          token,
          work: orphanWork,
          preparing: orphanGolden,
        }),
        { flag: "wx", mode: 0o600 },
      )
      .pipe(Effect.mapError((cause) => new MacosVmError({ reason: "ownership", cause })));
    owned = true;
    workOwned = orphanWork;
    preparing = orphanGolden;
    if (crashed) {
      if (workOwned) yield* discard(WORK);
      if (preparing) yield* stop(GOLDEN);
      workOwned = false;
      preparing = false;
      yield* saveOwner;
    }
  }).pipe(Effect.mapError(wrap));
  const registerDesktop = (name: string, key?: string) =>
    registry.register(
      `vm:${name}`,
      {
        kind: "macos-vm",
        role: key ? "thread" : "setup",
        threadId: key?.startsWith("thread:") ? ThreadId.make(key.slice(7)) : null,
        name: key ? "macOS desktop" : "macOS desktop setup",
      },
      Effect.gen(function* () {
        yield* assertOwner;
        const vm = yield* get(name);
        if (vm.status !== "running" || !vm.vncUrl)
          return yield* new MacosVmError({ reason: "display" });
        const url = yield* Effect.try({ try: () => new URL(vm.vncUrl!), catch: wrap });
        const host = url.hostname;
        if (
          url.protocol !== "vnc:" ||
          !(
            host === "localhost" ||
            host === "[::1]" ||
            (NodeNet.isIP(host) === 4 && host.startsWith("127."))
          )
        )
          return yield* new MacosVmError({ reason: "display" });
        const port = Number(url.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !url.password)
          return yield* new MacosVmError({ reason: "display" });
        const password = yield* Effect.try({
          try: () => decodeURIComponent(url.password),
          catch: () => new MacosVmError({ reason: "display" }),
        });
        return {
          kind: "tcp" as const,
          host: host === "[::1]" ? "::1" : host,
          port,
          password,
        };
      }).pipe(Effect.mapError(() => new ComputerDesktopViewerError({ desktopId: name }))),
    );
  const boot = (name: string) =>
    Effect.suspend(() =>
      lume([
        "run",
        name,
        "--storage",
        storage,
        "--detach",
        "--display",
        "none",
        "--vnc",
        "enabled",
        // Base64url gives the first eight ASCII bytes 48 bits of entropy even
        // with traditional VNC's eight-byte truncation. Never persist this in Rove.
        "--vnc-password",
        NodeCrypto.randomBytes(18).toString("base64url"),
        "--network",
        "nat",
      ]).pipe(Effect.asVoid),
    );
  const bootGolden = Effect.gen(function* () {
    preparing = true;
    yield* saveOwner;
    if ((yield* get(GOLDEN)).status === "running") return yield* registerDesktop(GOLDEN);
    yield* boot(GOLDEN);
    yield* registerDesktop(GOLDEN);
  });
  const ssh = (ip: string, args: ReadonlyArray<string>): Transport => ({
    command: "/usr/bin/ssh",
    args: [
      "-F",
      "/dev/null",
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ForwardAgent=no",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "StrictHostKeyChecking=accept-new",
      "-o",
      `UserKnownHostsFile=${path.join(directory, "known_hosts")}`,
      "-i",
      keyPath,
      `lume@${ip}`,
      DRIVER,
      ...args,
    ],
  });
  const address = Effect.fn("MacosVm.address")(
    function* (name: string) {
      // Boot is asynchronous with --detach. Effect's clock makes this bounded wait deterministic in tests.
      while (true) {
        const vm = yield* get(name);
        if (vm.status === "running" && vm.ipAddress && NodeNet.isIP(vm.ipAddress))
          return vm.ipAddress;
        yield* Effect.sleep("1 second");
      }
    },
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () => Effect.fail(new MacosVmError({ reason: "runtime" })),
    }),
  );
  const setupScript = Effect.gen(function* () {
    const publicKey = (yield* fs.readFileString(`${keyPath}.pub`)).trim();
    if (!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\r\n']*)?$/.test(publicKey))
      return yield* new MacosVmError({ reason: "runtime" });
    return (
      `umask 077 && mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys &&\n` +
      `(grep -qxF '${publicKey}' ~/.ssh/authorized_keys || printf '%s\\n' '${publicKey}' >> ~/.ssh/authorized_keys) &&\n` +
      `chmod 600 ~/.ssh/authorized_keys &&\n` +
      '/bin/bash -c "$(curl -fsSL https://cua.ai/driver/install.sh)" &&\n' +
      `${DRIVER} telemetry disable &&\n${DRIVER} permissions grant`
    );
  }).pipe(Effect.mapError(wrap));
  const setupCommand = Effect.gen(function* () {
    return (
      `${yield* setupScript}\n${DRIVER} list_apps '{}'\n${DRIVER} call get_desktop_state '{}' > /tmp/desktop.json\n` +
      `# Approve all prompts, then rerun list_apps and get_desktop_state until no prompts appear.\n${DRIVER} permissions status --json`
    );
  }).pipe(Effect.mapError(wrap));
  const check = Effect.gen(function* () {
    const base: ComputerUseMacosVm = {
      state: "needs-image",
      leased: leaseKey ? 1 : 0,
      capacity: CAPACITY,
      owners: leaseKey ? [leaseKey] : [],
      installCommand: INSTALL_COMMAND,
      requiredDiskBytes: REQUIRED_DISK,
      ...(lastError ? { lastError } : {}),
      ...(lumeVersion !== undefined ? { lumeVersion } : {}),
      ...(freeDiskBytes !== undefined ? { freeDiskBytes } : {}),
    };
    // Preparation owns Lume until it finishes; polling must not spawn processes or claim ownership.
    if (progress) return { ...base, state: "preparing", progress } satisfies ComputerUseMacosVm;
    if (!supported)
      return {
        ...base,
        state: "unavailable",
        detail: new MacosVmError({ reason: "unavailable" }).message,
      } satisfies ComputerUseMacosVm;
    const found = yield* discover.pipe(Effect.result);
    if (found._tag === "Failure")
      return {
        ...base,
        state: found.failure.reason === "missing-lume" ? "missing-lume" : "unavailable",
        detail: found.failure.message,
      } satisfies ComputerUseMacosVm;
    const result = yield* Effect.gen(function* () {
      yield* claim;
      freeDiskBytes = yield* measureFreeDisk;
      const records = yield* list;
      const vm = records.find((entry) => entry.name === GOLDEN);
      const unrecorded = !workOwned && records.some((entry) => entry.name === WORK);
      return {
        ...base,
        lumeVersion: found.success,
        ...(freeDiskBytes !== undefined ? { freeDiskBytes } : {}),
        ...(vm?.diskSize
          ? { diskBytes: vm.diskSize.allocated, virtualDiskBytes: vm.diskSize.total }
          : {}),
        ...(vm?.memorySize !== undefined ? { memoryBytes: vm.memorySize } : {}),
        state: unrecorded
          ? "unavailable"
          : !vm
            ? "needs-image"
            : (yield* fs.exists(sealedPath)) && vm.status === "stopped"
              ? "ready"
              : "needs-consent",
        ...(unrecorded ? { detail: new MacosVmError({ reason: "ownership" }).message } : {}),
        ...(vm && (yield* fs.exists(`${keyPath}.pub`))
          ? { setupCommand: yield* setupCommand }
          : {}),
      } satisfies ComputerUseMacosVm;
    }).pipe(Effect.mapError(wrap), Effect.result);
    return result._tag === "Success"
      ? result.success
      : ({
          ...base,
          state: "unavailable",
          lumeVersion: found.success,
          detail: result.failure.message,
        } satisfies ComputerUseMacosVm);
  });
  const openDisplay = Effect.gen(function* () {
    if (progress) {
      if (progress.phase !== "installing-driver")
        return yield* new MacosVmError({ reason: "preparing" });
      // Provisioning can wait for consent. Only view the golden VM already booted
      // by preparation; never start another boot while preparation owns it.
      yield* assertOwner;
      if ((yield* get(GOLDEN)).status !== "running")
        return yield* new MacosVmError({ reason: "display" });
      return yield* registerDesktop(GOLDEN);
    }
    if ((yield* check).state !== "needs-consent")
      return yield* new MacosVmError({ reason: "display" });
    yield* claim;
    yield* bootGolden;
    // Compatibility action: the client opens the registered setup desktop inline.
    // Viewer credentials are resolved privately on demand, not returned by this action.
  }).pipe(
    // Ownership is actionable; anything else may carry the credentialed URL, so it stays generic.
    Effect.mapError((cause) =>
      Schema.is(MacosVmError)(cause) &&
      (cause.reason === "ownership" || cause.reason === "preparing")
        ? cause
        : new MacosVmError({ reason: "display" }),
    ),
  );
  const prepareWork = Effect.gen(function* () {
    if (!(yield* fs.exists(keyPath)))
      yield* checked("/usr/bin/ssh-keygen", [
        "-t",
        "ed25519",
        "-N",
        "",
        "-C",
        "rove-cua",
        "-f",
        keyPath,
      ]);
    yield* fs.chmod(directory, 0o700);
    yield* fs.chmod(keyPath, 0o600);
    yield* fs.remove(sealedPath, { force: true });
    if (!(yield* list).some((vm) => vm.name === GOLDEN)) {
      const decoder = new TextDecoder();
      let pending = "";
      const consume = (text: string) => {
        pending += text;
        const lines = pending.split(/[\r\n]/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const update = parseLumeProgress(line);
          if (update && progress) {
            // Lume can emit a late download line after beginning image assembly.
            if (progress.phase === "unpacking" && update.phase === "downloading") continue;
            progress = { startedAt: progress.startedAt, ...update };
          }
        }
      };
      const result = yield* runner
        .run({
          command: executable ?? "lume",
          args: ["pull", IMAGE, GOLDEN, "--storage", storage],
          env: environment,
          timeout: "12 hours",
          outputMode: "truncate",
          onStdoutChunk: (chunk) => consume(decoder.decode(chunk, { stream: true })),
        })
        .pipe(Effect.mapError(wrap));
      consume(decoder.decode() + "\n");
      if (result.code !== 0) return yield* new MacosVmError({ reason: "runtime" });
    }
    if (progress) progress = { phase: "booting", startedAt: progress.startedAt };
    yield* bootGolden;
    yield* Effect.gen(function* () {
      yield* address(GOLDEN);
      if (progress) progress = { phase: "installing-driver", startedAt: progress.startedAt };
      // Lume 0.6.1 joins command argv with spaces. Pass one shell script unchanged;
      // the validated public key is single-quoted inside it, not interpolated by the host.
      yield* lume(
        ["ssh", GOLDEN, "--storage", storage, "--timeout", "600", yield* setupScript],
        "10 minutes",
      );
    }).pipe(
      Effect.catch(() =>
        Effect.logWarning(
          "Automatic macOS VM setup did not complete. Open the setup desktop, run the setup command in the VM's Terminal, then verify permissions.",
        ),
      ),
    );
  }).pipe(Effect.mapError(wrap));
  const prepare = Effect.gen(function* () {
    if (progress) return;
    yield* claim;
    if (leaseKey) return yield* new MacosVmError({ reason: "capacity" });
    // Only a pull needs the full image size; an existing golden VM re-prepares in place.
    // An unreadable df fails open, as check does.
    if (!(yield* list).some((vm) => vm.name === GOLDEN)) {
      const free = yield* measureFreeDisk;
      if (free !== undefined && free < REQUIRED_DISK)
        return yield* new MacosVmError({ reason: "disk", freeBytes: free });
    }
    lastError = undefined;
    progress = { phase: "downloading", startedAt: yield* Clock.currentTimeMillis };
    // Not forkChild: an RPC's completion must not interrupt the download.
    preparation = yield* prepareWork.pipe(
      Effect.catchCause((cause) =>
        Effect.sync(() => {
          if (!Cause.hasInterrupts(cause)) {
            const error = Cause.findErrorOption(cause);
            lastError = Option.isSome(error)
              ? wrap(error.value).message
              : new MacosVmError({ reason: "runtime" }).message;
          }
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          progress = undefined;
          preparation = undefined;
        }),
      ),
      Effect.forkIn(scope),
    );
  }).pipe(Effect.mapError(wrap));
  const cancel = Effect.gen(function* () {
    if (preparation) yield* Fiber.interrupt(preparation);
    progress = undefined;
    preparation = undefined;
    if (owned && preparing) {
      yield* assertOwner;
      yield* stop(GOLDEN);
      preparing = false;
      yield* saveOwner;
    }
  }).pipe(Effect.mapError(wrap));
  const verify = Effect.gen(function* () {
    if (progress) return yield* new MacosVmError({ reason: "preparing" });
    yield* claim;
    if (leaseKey) return yield* new MacosVmError({ reason: "capacity" });
    if (!(yield* fs.exists(sealedPath))) yield* bootGolden;
    const transport = ssh(yield* address(GOLDEN), ["permissions", "status", "--json"]);
    const result = yield* run(transport.command, transport.args);
    if (result.code !== 0 || Option.isNone(decodeConsent(result.stdout)))
      return yield* new MacosVmError({ reason: "consent" });
    yield* stop(GOLDEN);
    yield* fs.writeFileString(sealedPath, IMAGE);
    preparing = false;
    yield* saveOwner;
  }).pipe(Effect.mapError(wrap));
  const close = Effect.fn("MacosVm.close")(function* (key: string) {
    if (key !== leaseKey) return;
    yield* assertOwner;
    yield* registry.remove(`vm:${WORK}`);
    if (workOwned) yield* discard(WORK);
    leaseKey = undefined;
    workOwned = false;
    yield* saveOwner;
  });
  const release = Effect.gen(function* () {
    yield* cancel;
    if (!owned) return;
    yield* assertOwner;
    yield* registry.remove(`vm:${WORK}`);
    yield* registry.remove(`vm:${GOLDEN}`);
    // Also discard a partial clone left by an interrupted or failed acquisition.
    if (workOwned) yield* discard(WORK);
    leaseKey = undefined;
    workOwned = false;
    if (preparing) {
      yield* stop(GOLDEN);
      preparing = false;
    }
    yield* fs.remove(ownerPath);
    owned = false;
  }).pipe(Effect.mapError(wrap));
  const lease = Effect.fn("MacosVm.lease")(function* (key: string) {
    if (progress) return yield* new MacosVmError({ reason: "preparing" });
    yield* claim;
    if (leaseKey && leaseKey !== key) return yield* new MacosVmError({ reason: "capacity" });
    if (!leaseKey) {
      if (!(yield* fs.exists(sealedPath)) || (yield* get(GOLDEN)).status !== "stopped")
        return yield* new MacosVmError({ reason: "not-ready" });
      // Never silently delete an unrecorded VM: only crash recovery or explicit release may discard one.
      if ((yield* list).some((vm) => vm.name === WORK))
        return yield* new MacosVmError({ reason: "ownership" });
      leaseKey = key;
      workOwned = true;
      yield* saveOwner;
      yield* lume(
        ["clone", GOLDEN, WORK, "--source-storage", storage, "--dest-storage", storage],
        "5 minutes",
      );
      yield* boot(WORK);
    }
    const ip = yield* address(WORK);
    yield* registerDesktop(WORK, key);
    return ssh(ip, ["mcp"]);
  }, Effect.mapError(wrap));
  const remove = Effect.gen(function* () {
    yield* cancel;
    yield* claim;
    yield* discard(WORK);
    leaseKey = undefined;
    yield* discard(GOLDEN);
    workOwned = false;
    preparing = false;
    yield* saveOwner;
    yield* fs.remove(sealedPath, { force: true });
  }).pipe(Effect.mapError(wrap));
  const install = Effect.gen(function* () {
    if (!supported) return yield* new MacosVmError({ reason: "unavailable" });
    yield* checked("/bin/bash", ["-c", INSTALL_SCRIPT], "10 minutes");
    yield* discover;
  });
  return MacosVm.of({
    check,
    prepare,
    cancel,
    verify,
    openDisplay,
    lease,
    close,
    release,
    remove,
    install,
  });
});
