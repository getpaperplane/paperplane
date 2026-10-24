import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as RoveProjectFileLoader from "./RoveProjectFileLoader.ts";

const layerTest = Layer.empty.pipe(
  Layer.provideMerge(RoveProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "rove-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (cwd: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, "paperplane.json"), contents).pipe(Effect.orDie);
});

it.layer(layerTest)("RoveProjectFileLoader", (it) => {
  describe("loadState", () => {
    it.effect("reports a missing configuration", () =>
      Effect.gen(function* () {
        const loader = yield* RoveProjectFileLoader.RoveProjectFileLoader;
        const cwd = yield* makeTempDir;
        expect(yield* loader.loadState(cwd)).toEqual({ status: "missing" });
      }),
    );

    it.effect("detects only the legacy filename without reading or decoding it", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const cwd = yield* makeTempDir;
        // A directory cannot be read as JSON: detection must be existence-only.
        yield* fs.makeDirectory(path.join(cwd, "rove.json"));
        const loader = yield* RoveProjectFileLoader.RoveProjectFileLoader;
        expect(yield* loader.loadState(cwd)).toEqual({ status: "legacy-only" });
        expect(Option.isNone(yield* loader.load(cwd))).toBe(true);
      }),
    );

    it.effect("ignores legacy scripts and settings until the file is renamed", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const loader = yield* RoveProjectFileLoader.RoveProjectFileLoader;
        const cwd = yield* makeTempDir;
        const file = {
          defaultThreadEnvMode: "worktree",
          scripts: [{ name: "Setup", command: "vp i" }],
        };
        yield* fs.writeFileString(path.join(cwd, "rove.json"), JSON.stringify(file));
        expect(yield* loader.loadState(cwd)).toEqual({ status: "legacy-only" });
        expect(Option.isNone(yield* loader.load(cwd))).toBe(true);
        yield* fs.rename(path.join(cwd, "rove.json"), path.join(cwd, "paperplane.json"));
        expect(yield* loader.loadState(cwd)).toEqual({ status: "valid", file });
      }),
    );

    it.effect("prefers the new file even when invalid and never falls back to legacy", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const loader = yield* RoveProjectFileLoader.RoveProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* fs.writeFileString(
          path.join(cwd, "rove.json"),
          '{"defaultThreadEnvMode":"worktree"}',
        );
        yield* writeProjectFile(cwd, "{ broken");
        expect(yield* loader.loadState(cwd)).toEqual({ status: "invalid" });
        expect(Option.isNone(yield* loader.load(cwd))).toBe(true);
        yield* writeProjectFile(cwd, '{"defaultThreadEnvMode":"local"}');
        expect(yield* loader.loadState(cwd)).toEqual({
          status: "valid",
          file: { defaultThreadEnvMode: "local" },
        });
      }),
    );
  });

  describe("load", () => {
    it.effect("loads and decodes a valid paperplane.json", () =>
      Effect.gen(function* () {
        const loader = yield* RoveProjectFileLoader.RoveProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/logo.svg");
          expect(loaded.value.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
        }
      }),
    );

    it.effect("returns none when paperplane.json is missing", () =>
      Effect.gen(function* () {
        const loader = yield* RoveProjectFileLoader.RoveProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* RoveProjectFileLoader.RoveProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* RoveProjectFileLoader.RoveProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "scripts": [{ "name": "Dev" }] }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
