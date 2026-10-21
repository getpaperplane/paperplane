import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as NodeSqliteClient from "@rove-code/shared/nodeSqliteClient";
import { defaultSharedHomes, runSqliteState } from "./rove-sqlite-state.ts";
import * as HostProcess from "@rove-code/shared/HostProcess";
import { symlinksSupported } from "@rove-code/shared/testing/symlinks";

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

it.layer(NodeServices.layer)("rove-sqlite-state", (it) => {
  it.effect("reports each invalid SQL source with a specific error", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "rove-sqlite-state-input-" });

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
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "rove-sqlite-state-query-" });
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
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "rove-sqlite-state-fsync-" });
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
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "rove-sqlite-state-exec-" });
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
          prefix: "rove-sqlite-state-alias-",
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

        // Both live homes are refused; an unrelated worktree `.rove` is allowed.
        const otherHome = yield* fs.makeTempDirectoryScoped({ prefix: "rove-sqlite-state-home-" });
        yield* createFixtureDatabase(otherHome);
        for (const target of [aliasBaseDir, otherHome]) {
          const refused = yield* runSqliteState(
            { operation: "exec", baseDir: target, sql: "DELETE FROM fixtures" },
            { sharedHome: [baseDir, otherHome] },
          ).pipe(Effect.flip);
          assert.equal(refused._tag, "SqliteStateSharedHomeMutationError");
        }
        const worktreeBase = path.join(
          yield* fs.makeTempDirectoryScoped({ prefix: "rove-sqlite-state-wt-" }),
          ".rove",
        );
        yield* fs.makeDirectory(worktreeBase);
        yield* createFixtureDatabase(worktreeBase);
        const allowed = yield* runSqliteState(
          { operation: "exec", baseDir: worktreeBase, sql: "DELETE FROM fixtures" },
          { sharedHome: [baseDir, otherHome] },
        );
        assert.equal(allowed.operation, "exec");
      }),
  );

  it("defaults to refusing the live Rove home and upstream's home", () => {
    assert.deepEqual(defaultSharedHomes("/home/me"), ["/home/me/.rove-code", "/home/me/.rove"]);
  });
});
