// One-time installed-state conversion from Rove Code. Delete after the rename transition.
import * as HostProcess from "@getpaperplane/shared/HostProcess";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";
import {
  readServiceLaunchConfig,
  encodeServiceLaunchConfig,
  validateServiceLaunchConfig,
  DEFAULT_SERVICE_LAUNCH_CONFIG,
} from "./serviceLaunchConfig.ts";

export class InstalledStateMigrationError extends Schema.TaggedError<InstalledStateMigrationError>()(
  "InstalledStateMigrationError",
  { step: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message() {
    return `Old Rove Code installed-state conversion stopped: ${this.step}. Unrecognized installed files are never removed.`;
  }
}

const oldLabel = "io.github.hafiezul.rove.service";

/** Old policy files are removed only when they match a shipped profile byte-for-byte. */
export const findOldBrowserProfile = (directory = "/etc/apparmor.d") =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    return yield* fs.exists(path.join(directory, "rove-chrome-headless-shell"));
  });

export const retireOldBrowserProfile = Effect.fn("migration.browserProfile")(function* (input: {
  readonly profile: string;
  readonly directory?: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const directory = input.directory ?? "/etc/apparmor.d";
  const old = path.join(directory, "rove-chrome-headless-shell");
  const destination = path.join(directory, "paperplane-chrome-headless-shell");
  if (!(yield* fs.exists(old))) return;
  const contents = yield* fs.readFileString(old);
  const historical = input.profile.replaceAll(
    "paperplane-chrome-headless-shell",
    "rove-chrome-headless-shell",
  );
  const recognized = [
    historical,
    historical.replace("`paperplane browser setup`", "`rove browser setup`"),
    historical
      .replace("Paperplane's", "Rove Code's")
      .replace("`paperplane browser setup`", "`rove browser setup`"),
  ];
  if (
    !recognized.includes(contents) ||
    Option.isSome(yield* fs.readLink(old).pipe(Effect.option))
  ) {
    yield* Console.warn(
      `Left ${old} untouched: it is not an unmodified Paperplane/Rove Code browser profile. Review and remove it manually if obsolete.`,
    );
    return;
  }
  const oldLocal = path.join(directory, "local/rove-chrome-headless-shell");
  const newLocal = path.join(directory, "local/paperplane-chrome-headless-shell");
  if (yield* fs.exists(oldLocal)) {
    if (Option.isSome(yield* fs.readLink(oldLocal).pipe(Effect.option)))
      return yield* new InstalledStateMigrationError({
        step: "the old local browser override is a symlink; move it manually",
      });
    const overrides = yield* fs.readFileString(oldLocal);
    if (yield* fs.exists(newLocal)) {
      if ((yield* fs.readFileString(newLocal)) !== overrides)
        return yield* new InstalledStateMigrationError({
          step: "both browser profiles have different local overrides; merge them manually before retrying",
        });
    } else yield* fs.writeFileString(newLocal, overrides, { flag: "wx", mode: 0o644 });
  }
  if (yield* fs.exists(destination)) {
    if ((yield* fs.readFileString(destination)) !== input.profile)
      return yield* new InstalledStateMigrationError({
        step: "the new browser profile is customized; review the old policy manually",
      });
  } else yield* fs.writeFileString(destination, input.profile, { flag: "wx", mode: 0o644 });
  for (const args of [
    ["-r", destination],
    ["-R", old],
  ]) {
    const result = yield* runner.run({ command: "apparmor_parser", args });
    if (result.code !== 0)
      return yield* new InstalledStateMigrationError({
        step: "loading the new browser policy or unloading the old policy failed; old files are retained, retry setup",
      });
  }
  yield* fs.remove(old);
  if (yield* fs.exists(oldLocal)) yield* fs.remove(oldLocal);
});
const unescapeXml = (text: string) =>
  text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&amp;", "&");

function oldServiceEnvironment(contents: string, platform: NodeJS.Platform) {
  const values = new Map<string, string>();
  if (platform === "linux") {
    for (const match of contents.matchAll(/^Environment=(?:"([^"\n]+)"|([^\n]+))$/gm)) {
      const entry = match[1] ?? match[2] ?? "";
      const index = entry.indexOf("=");
      let value = entry.slice(index + 1);
      if (value.startsWith('"') && value.endsWith('"'))
        value = value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
      values.set(entry.slice(0, index), value.replaceAll("%%", "%"));
    }
  } else {
    const dict =
      /<key>EnvironmentVariables<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(contents)?.[1] ?? "";
    for (const match of dict.matchAll(/<key>([^<]+)<\/key>\s*<string>([^<]*)<\/string>/g))
      values.set(match[1]!, unescapeXml(match[2]!));
  }
  return values;
}

function isOldServiceOurs(contents: string, platform: NodeJS.Platform) {
  const program =
    platform === "linux"
      ? /^ExecStart=(.+)$/m.exec(contents)?.[1]
      : /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(contents)?.[1];
  if (!program) return false;
  // Match executable arguments, not a description or arbitrary environment variable.
  return (
    /(?:\/rove(?:\.exe)?(?:["\s<]|$)|\/(?:@rove-code\/cli|@rove\/rove[^/]*)\/dist\/bin\.mjs(?:["\s<]|$))/.test(
      program,
    ) && /(?:__service-launcher|serve)/.test(program)
  );
}

export const findOldService = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const home = yield* Config.String("HOME").pipe(Config.withDefault(""));
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!home || (platform !== "linux" && platform !== "darwin")) return undefined;
  const filename =
    platform === "linux"
      ? path.join(home, ".config/systemd/user/rove.service")
      : path.join(home, "Library/LaunchAgents", `${oldLabel}.plist`);
  const info = yield* fs.stat(filename).pipe(Effect.option);
  if (Option.isNone(info)) return undefined;
  const link = yield* fs.readLink(filename).pipe(Effect.option);
  const contents =
    info.value.type === "File" && Option.isNone(link) ? yield* fs.readFileString(filename) : "";
  return { filename, platform, home, contents, ours: isOldServiceOurs(contents, platform) };
});

/** Runs before default-home resolution, so an old service cannot hold the migration lock. */
export const retireOldService = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const uid = yield* HostProcess.UserId;
  const old = yield* findOldService;
  if (!old) return;
  if (!old.ours) {
    yield* Console.warn(
      `Left ${old.filename} untouched: its launcher is not recognizably Rove Code.`,
    );
    return;
  }
  if (old.platform === "linux" && (yield* fs.exists(`${old.filename}.d`))) {
    return yield* new InstalledStateMigrationError({
      step: `move custom overrides from ${old.filename}.d to paperplane.service.d, then stop and disable rove.service manually`,
    });
  }
  const env = oldServiceEnvironment(old.contents, old.platform);
  const sourceHome =
    env.get("ROVE_HOME") ?? env.get("PAPERPLANE_HOME") ?? path.join(old.home, ".rove-code");
  const destinationHome = yield* Config.String("PAPERPLANE_HOME").pipe(
    Config.withDefault(path.join(old.home, ".paperplane")),
  );
  if (sourceHome !== path.join(old.home, ".rove-code") && sourceHome !== destinationHome) {
    return yield* new InstalledStateMigrationError({
      step: `the old unit uses a custom home; set PAPERPLANE_HOME=${sourceHome} to keep serving that data before retrying`,
    });
  }
  if (/^EnvironmentFile=|^ExecStart=.*\s--(?:port|host|base-dir)/m.test(old.contents)) {
    return yield* new InstalledStateMigrationError({
      step: "the old unit has an environment file or custom launcher flags; reapply those settings with PAPERPLANE_* names and paperplane service install flags, then stop and disable the old service manually",
    });
  }
  const previous = yield* readServiceLaunchConfig(sourceHome);
  const destination = yield* readServiceLaunchConfig(destinationHome);
  const overrides = {
    ...(env.has("ROVE_HOST") ? { host: env.get("ROVE_HOST") } : {}),
    ...(env.has("ROVE_PORT") ? { port: Number(env.get("ROVE_PORT")) } : {}),
    ...(env.has("PATH") ? { environmentPath: env.get("PATH") } : {}),
  };
  const launch = yield* validateServiceLaunchConfig({
    ...DEFAULT_SERVICE_LAUNCH_CONFIG,
    ...Option.getOrUndefined(previous),
    ...overrides,
  });
  for (const key of env.keys()) {
    if (
      ![
        "ROVE_HOME",
        "PAPERPLANE_HOME",
        "ROVE_BOOT_SERVICE_UNIT",
        "PAPERPLANE_BOOT_SERVICE_UNIT",
        "ROVE_HOST",
        "ROVE_PORT",
        "PATH",
      ].includes(key)
    ) {
      yield* Console.warn(
        `Old service setting ${key} is not imported. Set its PAPERPLANE_* equivalent in the new service before relying on it.`,
      );
    }
  }
  // Persist settings before stopping anything. Existing Paperplane settings always win.
  if (Option.isNone(destination)) {
    const runtime = path.join(destinationHome, "runtime");
    yield* fs.makeDirectory(runtime, { recursive: true });
    yield* fs.writeFileString(
      path.join(runtime, "service-config.json"),
      yield* encodeServiceLaunchConfig(launch),
      { flag: "wx", mode: 0o600 },
    );
  }
  const run = Effect.fn("migration.serviceCommand")(function* (
    command: string,
    args: readonly string[],
  ) {
    const result = yield* runner.run({ command, args, timeout: "120 seconds" });
    if (result.code !== 0)
      return yield* new InstalledStateMigrationError({
        step: `run ${command} ${args.join(" ")} successfully before retrying`,
      });
  });
  if (old.platform === "linux") {
    yield* run("systemctl", ["--user", "disable", "--now", "rove.service"]);
  } else {
    if (uid === undefined)
      return yield* new InstalledStateMigrationError({ step: "cannot determine the launchd user" });
    const target = `gui/${uid}/${oldLabel}`;
    const loaded = yield* runner.run({ command: "launchctl", args: ["print", target] });
    if (loaded.code === 0) yield* run("launchctl", ["bootout", "--wait", target]);
    yield* run("launchctl", ["disable", target]);
  }
  yield* fs.remove(old.filename);
  if (old.platform === "linux") yield* run("systemctl", ["--user", "daemon-reload"]);
  yield* Console.log(
    `Removed the old Rove Code service at ${old.filename}; installing Paperplane next.`,
  );
}).pipe(
  Effect.mapError((cause) =>
    Schema.is(InstalledStateMigrationError)(cause)
      ? cause
      : new InstalledStateMigrationError({
          step: "reading or converting the old service settings",
          cause,
        }),
  ),
);
