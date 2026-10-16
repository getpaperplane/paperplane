import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

/** Linux process identity files, so private-desktop tests also run on macOS and Windows. */
export const withLinuxProcessFiles = (fs: FileSystem.FileSystem): FileSystem.FileSystem => ({
  ...fs,
  readFileString: (path, options) => {
    if (path === `/proc/${process.pid}/stat`) {
      // Field 22 (index 19 after the command) is the process start time.
      return Effect.succeed(`${process.pid} (rove test) ${Array(19).fill("0").join(" ")} 12345`);
    }
    if (path === "/proc/sys/kernel/random/boot_id") return Effect.succeed("test-boot\n");
    return fs.readFileString(path, options);
  },
  readLink: (path) =>
    path === "/proc/self/ns/pid" ? Effect.succeed("pid:[test]") : fs.readLink(path),
});
