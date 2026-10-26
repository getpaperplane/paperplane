import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/** Linux process identity files, so private-desktop tests also run on macOS and Windows. */
export const withLinuxProcessFiles = (fs: FileSystem.FileSystem): FileSystem.FileSystem => ({
  ...fs,
  exists: (path) =>
    path === "/sys/fs/cgroup/cgroup.controllers"
      ? Effect.succeed(true)
      : path === "/usr/bin/podman"
        ? Effect.succeed(false)
        : fs.exists(path),
  readFileString: (path, options) => {
    if (path === `/proc/${process.pid}/stat`) {
      // Field 22 (index 19 after the command) is the process start time.
      return Effect.succeed(
        `${process.pid} (paperplane test) ${Array(19).fill("0").join(" ")} 12345`,
      );
    }
    if (path === "/proc/sys/kernel/random/boot_id") return Effect.succeed("test-boot\n");
    if (path === "/proc/sys/user/max_user_namespaces") return Effect.succeed("65536\n");
    if (path === "/proc/sys/kernel/unprivileged_userns_clone") return Effect.succeed("1\n");
    return fs.readFileString(path, options);
  },
  readLink: (path) =>
    path === "/proc/self/ns/pid" ? Effect.succeed("pid:[test]") : fs.readLink(path),
});
