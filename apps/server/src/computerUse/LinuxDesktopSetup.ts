import { Environment as HostProcessEnvironment } from "@getpaperplane/shared/HostProcess";
import { ComputerUseSetupAuthorizationError } from "@getpaperplane/contracts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

export class LinuxDesktopSetupError extends Schema.TaggedError<LinuxDesktopSetupError>()(
  "LinuxDesktopSetupError",
  {
    reason: Schema.Literals(["root", "unsupported", "account", "packages"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "root":
        return "Linux computer use needs Paperplane to run as a regular user.";
      case "unsupported":
        return "Automatic Linux setup supports distributions using apt, dnf, pacman, or zypper. This host has none of these package managers.";
      case "account":
        return "Linux setup could not configure rootless access for the user running Paperplane.";
      case "packages":
        return "Linux setup could not install its system packages. Check this host's internet connection and package manager, then retry Install.";
    }
  }
}

// Kept inline so packaged CLI and desktop builds use the same installer without checkout files.
// Only this fixed script runs as root. The driver, image build, and desktops stay unprivileged.
const STARTED_MARKER = "paperplane-linux-setup-started-v1";
export const INSTALL_SCRIPT = `set -eu
printf '%s\\n' '${STARTED_MARKER}'
runtime_uid=$1
runtime_user=$(id -un "$runtime_uid") || exit 21
test "$runtime_uid" -gt 0 || exit 21
if command -v apt-get >/dev/null 2>&1; then
  manager=apt
elif command -v dnf >/dev/null 2>&1; then
  manager=dnf
elif command -v pacman >/dev/null 2>&1; then
  manager=pacman
elif command -v zypper >/dev/null 2>&1; then
  manager=zypper
else
  exit 20
fi
case "$manager" in
  apt)
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y podman uidmap fuse-overlayfs slirp4netns bash curl ca-certificates tar libxi6 libxkbcommon0 libx11-6
    ;;
  dnf) dnf install -y podman shadow-utils fuse-overlayfs slirp4netns bash curl ca-certificates tar libXi libxkbcommon libX11 ;;
  pacman) pacman -S --needed --noconfirm podman shadow fuse-overlayfs slirp4netns bash curl ca-certificates tar libxi libxkbcommon libx11 ;;
  zypper) zypper --non-interactive install podman shadow fuse-overlayfs slirp4netns bash curl ca-certificates tar libXi6 libxkbcommon0 libX11-6 ;;
esac
exec 9>/etc/.paperplane-computer-use.lock
flock -x 9
touch /etc/subuid /etc/subgid
for mapping in /etc/subuid /etc/subgid; do
  if awk -F: -v user="$runtime_user" -v uid="$runtime_uid" '
    ($1 == user || $1 == uid) && $3 >= 65536 { found = 1 }
    END { exit !found }
  ' "$mapping"; then
    continue
  fi
  start=$(awk -F: '
    BEGIN { next_id = 100000 }
    $2 + $3 > next_id { next_id = $2 + $3 }
    END { printf "%.0f", next_id }
  ' /etc/subuid /etc/subgid)
  end=$((start + 65535))
  test "$end" -lt 4294967295 || exit 21
  case "$mapping" in
    /etc/subuid) usermod --add-subuids "$start-$end" "$runtime_user" || exit 21 ;;
    /etc/subgid) usermod --add-subgids "$start-$end" "$runtime_user" || exit 21 ;;
  esac
done
`;

const decodeUid = Schema.decodeUnknownEffect(Schema.String.check(Schema.isPattern(/^[1-9]\d*$/)));

/** Runs only the fixed host setup script as root; authorization is consumed through sudo stdin. */
export const install = Effect.fn("LinuxDesktopSetup.install")(function* (
  authorization: Redacted.Redacted<string> | undefined,
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const environment = yield* HostProcessEnvironment;
  if (authorization) {
    yield* Effect.addFinalizer(() => Effect.sync(() => Redacted.wipeUnsafe(authorization)));
    const password = Redacted.value(authorization);
    if (password.length === 0 || password.length > 1024 || /[\r\n\0]/.test(password))
      return yield* new ComputerUseSetupAuthorizationError({ reason: "incorrect" });
  }
  const identity = yield* runner
    .run({ command: "/usr/bin/id", args: ["-u"], env: environment })
    .pipe(Effect.mapError((cause) => new LinuxDesktopSetupError({ reason: "account", cause })));
  if (identity.code !== 0)
    return yield* new LinuxDesktopSetupError({ reason: "account", cause: identity });
  const uid = yield* decodeUid(identity.stdout.trim()).pipe(
    Effect.mapError(
      (cause) =>
        new LinuxDesktopSetupError({
          reason: identity.stdout.trim() === "0" ? "root" : "account",
          cause,
        }),
    ),
  );
  const result = yield* runner
    .run({
      command: "/usr/bin/sudo",
      args: [
        ...(authorization ? ["-S", "-k", "-p", ""] : ["-n"]),
        "--",
        "/usr/bin/env",
        "-i",
        "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
        "/bin/sh",
        "-c",
        INSTALL_SCRIPT,
        "paperplane-computer-use",
        uid,
      ],
      env: { ...environment, LC_ALL: "C" },
      stdin: authorization ? `${Redacted.value(authorization)}\n` : undefined,
      timeout: "15 minutes",
      outputMode: "truncate",
    })
    .pipe(
      Effect.mapError((cause) =>
        cause._tag === "ProcessSpawnError"
          ? new ComputerUseSetupAuthorizationError({ reason: "unavailable" })
          : new LinuxDesktopSetupError({ reason: "packages", cause }),
      ),
    );
  if (result.code !== 0) {
    if (!result.stdout.includes(STARTED_MARKER)) {
      const denied =
        /not in the sudoers|not allowed|may not run sudo|must have a tty|a terminal is required/i.test(
          result.stderr,
        );
      return yield* new ComputerUseSetupAuthorizationError({
        reason: denied ? "denied" : authorization ? "incorrect" : "required",
      });
    }
    const reason = result.code === 20 ? "unsupported" : result.code === 21 ? "account" : "packages";
    return yield* new LinuxDesktopSetupError({ reason, cause: result });
  }
}, Effect.scoped);
