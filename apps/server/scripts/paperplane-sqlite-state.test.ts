import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@getpaperplane/shared/nodeSqliteClient";
import { runSqliteState } from "./paperplane-sqlite-state.ts";
import * as HostProcess from "@getpaperplane/shared/HostProcess";
import { symlinksSupported } from "@getpaperplane/shared/testing/symlinks";

const createFixtureDatabase = Effect.fn("createSqliteStateFixtureDatabase")(function* (
  baseDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`CREATE TABLE fixtures (id INTEGER PRIMARY KEY, label TEXT NOT NULL)`;
    yield* sql`INSERT INTO fixtures (id, label) VALUES (1, 'existing')`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
});

it.layer(NodeServices.layer)("paperplane-sqlite-state", (it) => {
  it.effect("reports each invalid SQL source with a specific error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "paperplane-sqlite-state-input-",
      });

      const multipleSources = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "SELECT 1",
        file: "fixture.sql",
      }).pipe(Effect.flip);
      assert.equal(multipleSources._tag, "SqliteStateMultipleSqlSourcesError");
      assert.equal(multipleSources.message, "Provide only one of --sql or --file.");

      const missingSource = yield* runSqliteState({ operation: "query", baseDir }).pipe(
        Effect.flip,
      );
      assert.equal(missingSource._tag, "SqliteStateMissingSqlSourceError");
      assert.equal(missingSource.message, "Provide one of --sql or --file.");

      const emptySql = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "   ",
      }).pipe(Effect.flip);
      assert.equal(emptySql._tag, "SqliteStateEmptySqlError");
      assert.equal(emptySql.message, "SQL input is empty.");
    }),
  );

  it.effect("queries an isolated database through Effect SQL", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "paperplane-sqlite-state-query-",
      });
      yield* createFixtureDatabase(baseDir);

      const result = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "SELECT id, label FROM fixtures",
      });

      assert.equal(result.operation, "query");
      if (result.operation === "query") {
        assert.deepStrictEqual(result.rows, [{ id: 1, label: "existing" }]);
      }
    }),
  );

  it.effect("enables checkpoint_fullfsync on its direct connection", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({
        prefix: "paperplane-sqlite-state-fsync-",
      });
      yield* createFixtureDatabase(baseDir);

      const result = yield* runSqliteState({
        operation: "query",
        baseDir,
        sql: "PRAGMA checkpoint_fullfsync",
      });

      assert.equal(result.operation, "query");
      if (result.operation === "query") {
        assert.deepStrictEqual(result.rows, [{ checkpoint_fullfsync: 1 }]);
      }
    }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "backs up isolated state before writes and refuses the shared home",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({
          prefix: "paperplane-sqlite-state-exec-",
        });
        yield* createFixtureDatabase(baseDir);

        const mutation = yield* runSqliteState({
          operation: "exec",
          baseDir,
          sql: "INSERT INTO fixtures (id, label) VALUES (2, 'seeded')",
        });
        assert.equal(mutation.operation, "exec");
        if (mutation.operation === "exec" && (yield* HostProcess.Platform) !== "win32") {
          // NTFS has no POSIX mode bits to report.
          assert.equal((yield* fs.stat(mutation.backup)).mode & 0o777, 0o600);
        }

        const error = yield* runSqliteState(
          {
            operation: "exec",
            baseDir,
            sql: "DELETE FROM fixtures",
          },
          { sharedHome: baseDir },
        ).pipe(Effect.flip);
        assert.equal(error._tag, "SqliteStateSharedHomeMutationError");

        const aliasParent = yield* fs.makeTempDirectoryScoped({
          prefix: "paperplane-sqlite-state-alias-",
        });
        const aliasBaseDir = path.join(aliasParent, "shared-home-alias");
        yield* fs.symlink(baseDir, aliasBaseDir);
        const aliasError = yield* runSqliteState(
          {
            operation: "exec",
            baseDir: aliasBaseDir,
            sql: "DELETE FROM fixtures",
          },
          { sharedHome: baseDir },
        ).pipe(Effect.flip);
        assert.equal(aliasError._tag, "SqliteStateSharedHomeMutationError");

        // A worktree's own `.paperplane` dev state is not the live home.
        const worktreeBase = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-sqlite-state-wt-" }),
          ".paperplane",
        );
        yield* fs.makeDirectory(worktreeBase);
        yield* createFixtureDatabase(worktreeBase);
        const allowed = yield* runSqliteState(
          { operation: "exec", baseDir: worktreeBase, sql: "DELETE FROM fixtures" },
          { sharedHome: baseDir },
        );
        assert.equal(allowed.operation, "exec");
      }),
  );

  it.effect("refuses the Paperplane home and its Rove Code backup by default", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "paperplane-sqlite-state-user-" });
      for (const name of [".paperplane", ".rove-code"]) {
        const sharedHome = path.join(home, name);
        yield* createFixtureDatabase(sharedHome);
        const error = yield* runSqliteState({
          operation: "exec",
          baseDir: sharedHome,
          sql: "DELETE FROM fixtures",
        }).pipe(Effect.provideService(HostProcess.HomeDirectory, home), Effect.flip);
        assert.equal(error._tag, "SqliteStateSharedHomeMutationError");
      }
      // Guarding must not migrate the old home as a side effect.
      assert.isFalse(yield* fs.exists(path.join(home, ".paperplane", "home-migration.json")));
    }),
  );
});
