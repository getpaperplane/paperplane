import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";
import { INSTALL_SCRIPT } from "./LinuxDesktopSetup.ts";

const withHost = <A, E>(
  manager: "apt-get" | "dnf" | "pacman" | "zypper" | "none",
  body: (host: {
    setup: Effect.Effect<ProcessRunner.ProcessRunOutput, ProcessRunner.ProcessRunError>;
    directory: string;
    calls: () => ReturnType<FileSystem.FileSystem["readFileString"]>;
  }) => Effect.Effect<A, E, FileSystem.FileSystem>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner.ProcessRunner;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-linux-setup-" });
    const bin = `${directory}/bin`;
    yield* fs.makeDirectory(bin);
    yield* fs.makeDirectory(`${directory}/etc`);
    yield* fs.writeFileString(`${directory}/calls`, "");
    for (const tool of ["awk", "flock", "touch"]) {
      yield* fs.symlink(`/usr/bin/${tool}`, `${bin}/${tool}`);
    }
    const tools = manager === "none" ? ["id", "usermod"] : ["id", "usermod", manager];
    for (const tool of tools) {
      yield* fs.writeFileString(
        `${bin}/${tool}`,
        `#!${process.execPath}
const fs = require("node:fs");
const directory = ${JSON.stringify(directory)};
const tool = ${JSON.stringify(tool)};
const args = process.argv.slice(2);
if (tool === "id") { console.log("paperplane-user"); process.exit(0); }
fs.appendFileSync(directory + "/calls", JSON.stringify([tool, ...args]) + "\\n");
if (fs.existsSync(directory + "/fail-packages") && tool !== "usermod") process.exit(100);
if (tool === "usermod") {
  const [start, end] = args[1].split("-").map(Number);
  const file = args[0] === "--add-subuids" ? "subuid" : "subgid";
  fs.appendFileSync(directory + "/etc/" + file, args[2] + ":" + start + ":" + (end - start + 1) + "\\n");
}
`,
      );
      yield* fs.chmod(`${bin}/${tool}`, 0o755);
    }
    // Redirect only system configuration files into the sandbox; execute the actual setup script.
    const setup = runner.run({
      command: "/bin/sh",
      args: [
        "-c",
        INSTALL_SCRIPT.replaceAll("/etc/", `${directory}/etc/`),
        "paperplane-computer-use-test",
        "1000",
      ],
      env: { PATH: bin },
    });
    return yield* body({
      setup,
      directory,
      calls: () => fs.readFileString(`${directory}/calls`),
    });
  }).pipe(
    Effect.scoped,
    Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  );

for (const [manager, expected] of [
  [
    "apt-get",
    '["apt-get","update"]\n["apt-get","install","-y","podman","uidmap","fuse-overlayfs","slirp4netns","bash","curl","ca-certificates","tar","libxi6","libxkbcommon0","libx11-6"]\n',
  ],
  [
    "dnf",
    '["dnf","install","-y","podman","shadow-utils","fuse-overlayfs","slirp4netns","bash","curl","ca-certificates","tar","libXi","libxkbcommon","libX11"]\n',
  ],
  [
    "pacman",
    '["pacman","-S","--needed","--noconfirm","podman","shadow","fuse-overlayfs","slirp4netns","bash","curl","ca-certificates","tar","libxi","libxkbcommon","libx11"]\n',
  ],
  [
    "zypper",
    '["zypper","--non-interactive","install","podman","shadow","fuse-overlayfs","slirp4netns","bash","curl","ca-certificates","tar","libXi6","libxkbcommon0","libX11-6"]\n',
  ],
] as const) {
  it.effect.skipIf(process.platform !== "linux")(
    `installs through ${manager} and preserves existing rootless mappings`,
    () =>
      withHost(manager, ({ setup, directory, calls }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          yield* fs.writeFileString(`${directory}/etc/subuid`, "paperplane-user:100000:65536\n");
          yield* fs.writeFileString(`${directory}/etc/subgid`, "1000:200000:65536\n");
          expect((yield* setup).code).toBe(0);
          expect(yield* calls()).toBe(expected);
          expect(yield* fs.readFileString(`${directory}/etc/subuid`)).toBe(
            "paperplane-user:100000:65536\n",
          );
          expect(yield* fs.readFileString(`${directory}/etc/subgid`)).toBe("1000:200000:65536\n");
        }),
      ),
  );
}

it.effect.skipIf(process.platform !== "linux")(
  "allocates non-overlapping rootless mappings once and preserves other users",
  () =>
    withHost("apt-get", ({ setup, directory, calls }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${directory}/etc/subuid`, "other:100000:65536\n");
        yield* fs.writeFileString(`${directory}/etc/subgid`, "other:200000:65536\n");
        expect((yield* setup).code).toBe(0);
        expect(yield* fs.readFileString(`${directory}/etc/subuid`)).toBe(
          "other:100000:65536\npaperplane-user:265536:65536\n",
        );
        expect(yield* fs.readFileString(`${directory}/etc/subgid`)).toBe(
          "other:200000:65536\npaperplane-user:331072:65536\n",
        );
        const before = yield* calls();
        yield* fs.writeFileString(`${directory}/calls`, "");
        expect((yield* setup).code).toBe(0);
        expect(before).toContain("usermod");
        expect(yield* calls()).not.toContain("usermod");
      }),
    ),
);

it.effect.skipIf(process.platform !== "linux")(
  "stops on package installation failure before changing account mappings",
  () =>
    withHost("apt-get", ({ setup, directory, calls }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.writeFileString(`${directory}/fail-packages`, "");
        expect((yield* setup).code).toBe(100);
        expect(yield* calls()).not.toContain("usermod");
        expect(yield* fs.exists(`${directory}/etc/subuid`)).toBe(false);
      }),
    ),
);

it.effect.skipIf(process.platform !== "linux")(
  "rejects unsupported hosts before changing the system",
  () =>
    withHost("none", ({ setup, directory, calls }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        expect((yield* setup).code).toBe(20);
        expect(yield* calls()).toBe("");
        expect(yield* fs.exists(`${directory}/etc/.paperplane-computer-use.lock`)).toBe(false);
      }),
    ),
);
