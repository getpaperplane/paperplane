import { assert, it, describe } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";

import * as VcsProjectConfig from "./VcsProjectConfig.ts";

const layerTest = VcsProjectConfig.layer.pipe(
  Layer.provide(NodeServices.layer),
  Layer.provideMerge(NodeServices.layer),
);

const fixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "paperplane-vcs-config-test-" });
  const config = yield* VcsProjectConfig.VcsProjectConfig;
  return { fileSystem, path, root, config, configPath: path.join(root, "paperplane.vcs.json") };
});

describe("VcsProjectConfig", () => {
  it.layer(layerTest)((it) => {
    it.effect("uses an explicit requested VCS kind before config", () =>
      Effect.gen(function* () {
        const { config, root, configPath, fileSystem } = yield* fixture;
        yield* fileSystem.writeFileString(configPath, '{"vcs":{"kind":"git"}}');
        assert.equal(yield* config.resolveKind({ cwd: root, requestedKind: "jj" }), "jj");
      }),
    );

    it.effect("discovers paperplane.vcs.json from nested workspaces", () =>
      Effect.gen(function* () {
        const { config, root, configPath, fileSystem, path } = yield* fixture;
        const nested = path.join(root, "packages", "app");
        yield* fileSystem.makeDirectory(nested, { recursive: true });
        yield* fileSystem.writeFileString(configPath, '{"vcs":{"kind":"jj"}}');
        assert.equal(yield* config.resolveKind({ cwd: nested }), "jj");
      }),
    );

    it.effect("ignores legacy rules without reading them and warns once per path", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => messages.push(message));
      return Effect.gen(function* () {
        const { config, root, configPath, fileSystem, path } = yield* fixture;
        const legacyPath = path.join(root, ".rove", "vcs.json");
        const nested = path.join(root, "packages");
        yield* fileSystem.makeDirectory(path.dirname(legacyPath));
        yield* fileSystem.makeDirectory(nested);
        // A directory cannot be read as JSON: detection must only check existence.
        yield* fileSystem.makeDirectory(legacyPath);
        assert.equal(yield* config.resolveKind({ cwd: nested }), "auto");
        assert.equal(yield* config.resolveKind({ cwd: root }), "auto");
        assert.deepEqual(messages, [
          [`${legacyPath} is ignored; rename it to ${configPath} to apply its VCS rules.`],
        ]);
        yield* fileSystem.writeFileString(configPath, '{"vcsKind":"jj"}');
        assert.equal(yield* config.resolveKind({ cwd: nested }), "jj");
        assert.equal(messages.length, 1);
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });

    it.effect("prefers the new config without warning when both names exist", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => messages.push(message));
      return Effect.gen(function* () {
        const { config, root, configPath, fileSystem, path } = yield* fixture;
        yield* fileSystem.makeDirectory(path.join(root, ".rove"));
        yield* fileSystem.writeFileString(
          path.join(root, ".rove", "vcs.json"),
          '{"vcsKind":"git"}',
        );
        yield* fileSystem.writeFileString(configPath, '{"vcsKind":"jj"}');
        assert.equal(yield* config.resolveKind({ cwd: root }), "jj");
        assert.deepEqual(messages, []);
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });

    it.effect("continues to parent configs after a candidate inspect failure", () => {
      const messages: unknown[] = [];
      const logger = Logger.make<unknown, void>(({ message }) => messages.push(message));
      return Effect.gen(function* () {
        const { config, root, configPath, fileSystem, path } = yield* fixture;
        const cwd = path.join(root, "invalid\0child");
        yield* fileSystem.writeFileString(configPath, '{"vcs":{"kind":"jj"}}');
        assert.equal(yield* config.resolveKind({ cwd }), "jj");
        // SAFETY: Logger messages are arrays containing the logged error.
        const [error] = messages[0] as ReadonlyArray<unknown>;
        assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
        assert.deepInclude(error, {
          operation: "inspect",
          cwd,
          configPath: path.join(cwd, "paperplane.vcs.json"),
          _tag: "VcsProjectConfigError",
        });
      }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
    });

    it.effect("falls back to auto when no config exists", () =>
      Effect.gen(function* () {
        const { config, root } = yield* fixture;
        assert.equal(yield* config.resolveKind({ cwd: root }), "auto");
      }),
    );

    for (const [name, raw, operation, causeTag] of [
      ["malformed JSON", "{not json", "decode", "SchemaError"],
      ["invalid kind", '{"vcs":{"kind":"svn"}}', "decode", "SchemaError"],
      ["unreadable path", undefined, "read", "PlatformError"],
    ] as const) {
      it.effect(`falls back to auto and logs context for ${name}`, () => {
        const messages: unknown[] = [];
        const logger = Logger.make<unknown, void>(({ message }) => messages.push(message));
        return Effect.gen(function* () {
          const { config, root, configPath, fileSystem } = yield* fixture;
          if (raw === undefined) yield* fileSystem.makeDirectory(configPath);
          else yield* fileSystem.writeFileString(configPath, raw);
          assert.equal(yield* config.resolveKind({ cwd: root }), "auto");
          // SAFETY: Logger messages are arrays containing the logged error.
          const [error] = messages[0] as ReadonlyArray<unknown>;
          assert.instanceOf(error, VcsProjectConfig.VcsProjectConfigError);
          assert.equal(
            error.message,
            `Failed to ${operation} VCS project config at ${configPath}.`,
          );
          assert.deepInclude(error, {
            operation,
            cwd: root,
            configPath,
            _tag: "VcsProjectConfigError",
          });
          assert.deepInclude(error.cause, { _tag: causeTag });
        }).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false })));
      });
    }
  });
});
