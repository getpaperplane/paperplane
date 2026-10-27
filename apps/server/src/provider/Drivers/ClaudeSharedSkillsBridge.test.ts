import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ensureClaudeSharedSkillsBridge } from "./ClaudeSharedSkillsBridge.ts";

it.layer(NodeServices.layer)("ensureClaudeSharedSkillsBridge", (it) => {
  it.effect("bridges ~/.agents/skills through a .claude/skills symlink", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-bridge-" });
      const home = path.join(tempDir, "home");
      const stateDir = path.join(tempDir, "state");
      const shared = path.join(home, ".agents", "skills");
      yield* fs.makeDirectory(shared, { recursive: true });

      const bridgeDir = yield* ensureClaudeSharedSkillsBridge({
        stateDir,
        home,
        claudeConfigDir: path.join(home, ".claude"),
      });

      assert.equal(bridgeDir, path.join(stateDir, "claude-shared-skills"));
      assert.equal(yield* fs.readLink(path.join(bridgeDir!, ".claude", "skills")), shared);
    }),
  );

  it.effect("is idempotent when the bridge already points at the shared folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-bridge-" });
      const home = path.join(tempDir, "home");
      const stateDir = path.join(tempDir, "state");
      const shared = path.join(home, ".agents", "skills");
      yield* fs.makeDirectory(shared, { recursive: true });
      const input = { stateDir, home, claudeConfigDir: path.join(home, ".claude") };

      const first = yield* ensureClaudeSharedSkillsBridge(input);
      const second = yield* ensureClaudeSharedSkillsBridge(input);

      assert.equal(second, first);
      assert.equal(yield* fs.readLink(path.join(first!, ".claude", "skills")), shared);
    }),
  );

  it.effect("re-points a stale bridge symlink at the shared folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-bridge-" });
      const home = path.join(tempDir, "home");
      const stateDir = path.join(tempDir, "state");
      const shared = path.join(home, ".agents", "skills");
      const stale = path.join(tempDir, "old-skills");
      yield* fs.makeDirectory(shared, { recursive: true });
      yield* fs.makeDirectory(stale, { recursive: true });

      const claudeDir = path.join(stateDir, "claude-shared-skills", ".claude");
      yield* fs.makeDirectory(claudeDir, { recursive: true });
      yield* fs.symlink(stale, path.join(claudeDir, "skills"));

      const bridgeDir = yield* ensureClaudeSharedSkillsBridge({
        stateDir,
        home,
        claudeConfigDir: path.join(home, ".claude"),
      });

      assert.equal(yield* fs.readLink(path.join(bridgeDir!, ".claude", "skills")), shared);
    }),
  );

  it.effect("skips the bridge when ~/.agents/skills is missing", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-bridge-" });
      const home = path.join(tempDir, "home");
      const stateDir = path.join(tempDir, "state");
      yield* fs.makeDirectory(home, { recursive: true });

      const bridgeDir = yield* ensureClaudeSharedSkillsBridge({
        stateDir,
        home,
        claudeConfigDir: path.join(home, ".claude"),
      });

      assert.equal(bridgeDir, undefined);
      assert.equal(yield* fs.exists(path.join(stateDir, "claude-shared-skills")), false);
    }),
  );

  it.effect(
    "skips the bridge when the user's Claude skills already resolve to the shared folder",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-bridge-" });
        const home = path.join(tempDir, "home");
        const stateDir = path.join(tempDir, "state");
        const shared = path.join(home, ".agents", "skills");
        const claudeConfigDir = path.join(home, ".claude");
        yield* fs.makeDirectory(shared, { recursive: true });
        yield* fs.makeDirectory(claudeConfigDir, { recursive: true });
        yield* fs.symlink(shared, path.join(claudeConfigDir, "skills"));

        const bridgeDir = yield* ensureClaudeSharedSkillsBridge({
          stateDir,
          home,
          claudeConfigDir,
        });

        assert.equal(bridgeDir, undefined);
      }),
  );
});
