// @effect-diagnostics-next-line nodeBuiltinImport:off -- Mock statfs, absent from Effect FileSystem.
import * as NodeFSP from "node:fs/promises";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@rove-code/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import { afterEach, vi } from "vite-plus/test";

import * as DatabaseMaintenance from "./DatabaseMaintenance.ts";
import * as Sqlite from "./Sqlite.ts";
import * as ServerConfig from "../config.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof NodeFSP>()),
  statfs: vi.fn(),
}));
const diskSpace = vi.mocked(NodeFSP.statfs);
afterEach(() => vi.resetAllMocks());

const fixture = Effect.fnUntraced(function* (retainedMiB = 0, freedMiB = 0) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const dbPath = path.join(yield* fs.makeTempDirectoryScoped(), "statev2.sqlite");
  yield* Effect.flatMap(ProjectionMaintenance.ProjectionMaintenanceV2, (p) => p.rebuild).pipe(
    Effect.provide(
      ProjectionMaintenance.layer.pipe(
        Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer)),
        Layer.provideMerge(Sqlite.layerFromPath(dbPath)),
      ),
    ),
  );
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA auto_vacuum = NONE`;
    yield* sql`VACUUM`;
    yield* sql`CREATE TABLE retained (value BLOB)`;
    yield* sql`INSERT INTO retained VALUES (zeroblob(${retainedMiB * 1024 ** 2}))`;
    yield* sql`CREATE TABLE discarded (value BLOB)`;
    yield* sql`INSERT INTO discarded VALUES (zeroblob(${freedMiB * 1024 ** 2}))`;
    yield* sql`DROP TABLE discarded`;
    yield* sql`PRAGMA wal_checkpoint(TRUNCATE)`;
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
  return dbPath;
});

const ampleDisk = () =>
  diskSpace.mockResolvedValue({
    type: 0n,
    bsize: 4096n,
    blocks: 2n ** 30n,
    bfree: 2n ** 30n,
    bavail: 2n ** 30n,
    files: 0n,
    ffree: 0n,
  });

it.layer(DatabaseMaintenance.layer.pipe(Layer.provideMerge(NodeServices.layer)))(
  "startup compaction",
  (it) => {
    for (const [name, retained, freed, enabled] of [
      ["upgrades a tiny database", 0, 0, true],
      ["reclaims substantial free space", 1, 256, true],
      ["skips below the absolute threshold", 64, 1, false],
      ["skips below the relative threshold", 800, 256, false],
    ] as const) {
      it.effect(
        name,
        () =>
          Effect.gen(function* () {
            ampleDisk();
            const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
            const dbPath = yield* fixture(retained, freed);
            const before = yield* maintenance.inspect(dbPath);
            yield* maintenance.compactOnStartup(dbPath);
            const after = yield* maintenance.inspect(dbPath);
            assert.equal(after.incrementalVacuumEnabled, enabled);
            if (enabled && freed > 0)
              assert.isBelow(after.databaseBytes, before.databaseBytes - 250 * 1024 ** 2);
            if (!enabled) assert.equal(after.databaseBytes, before.databaseBytes);
          }).pipe(Effect.scoped),
        30_000,
      );
    }

    for (const [name, devPath, lowDisk, enabled] of [
      ["upgrades before configured persistence becomes available", false, false, true],
      ["does not compact an implicit dev database", true, false, false],
      ["opens configured persistence when compaction is deferred", false, true, false],
    ] as const) {
      it.effect(name, () =>
        Effect.gen(function* () {
          ampleDisk();
          if (lowDisk) diskSpace.mockRejectedValue(new Error("disk inspection failed"));
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const source = yield* fixture();
          const baseDir = yield* fs.makeTempDirectoryScoped();
          const config = yield* ServerConfig.ServerConfig.pipe(
            Effect.provide(ServerConfig.layerTest(baseDir, baseDir)),
          );
          const dbPath = devPath ? path.join(baseDir, "dev", "statev2.sqlite") : config.dbPath;
          yield* fs.makeDirectory(path.dirname(dbPath), { recursive: true });
          yield* fs.copyFile(source, dbPath);
          yield* Effect.gen(function* () {
            const sql = yield* SqlClient.SqlClient;
            const mode = yield* sql<{ readonly auto_vacuum: number }>`PRAGMA auto_vacuum`;
            assert.equal(mode[0]?.auto_vacuum, enabled ? 2 : 0);
            // The persistence layer is usable even after the startup failure.
            yield* sql`INSERT INTO retained VALUES ('ready')`;
          }).pipe(
            Effect.provide(
              Sqlite.layerConfig.pipe(Layer.provide(ServerConfig.layer({ ...config, dbPath }))),
            ),
          );
          if (devPath) assert.equal(diskSpace.mock.calls.length, 0);
        }).pipe(Effect.scoped),
      );
    }

    it.effect("skips low disk without changing the database", () =>
      Effect.gen(function* () {
        ampleDisk();
        diskSpace.mockResolvedValueOnce({
          type: 0n,
          bsize: 4096n,
          blocks: 1n,
          bfree: 1n,
          bavail: 1n,
          files: 0n,
          ffree: 0n,
        });
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = yield* fixture();
        yield* maintenance.compactOnStartup(dbPath);
        assert.isFalse((yield* maintenance.inspect(dbPath)).incrementalVacuumEnabled);
      }).pipe(Effect.scoped),
    );

    it.effect("does not repeat an incremental database upgrade", () =>
      Effect.gen(function* () {
        ampleDisk();
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = yield* fixture();
        yield* maintenance.compactOnStartup(dbPath);
        diskSpace.mockClear();
        yield* maintenance.compactOnStartup(dbPath);
        assert.equal(diskSpace.mock.calls.length, 0);
      }).pipe(Effect.scoped),
    );

    it.effect("skips in-memory databases", () =>
      Effect.gen(function* () {
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        yield* maintenance.compactOnStartup(":memory:");
        assert.equal(diskSpace.mock.calls.length, 0);
      }),
    );

    it.effect("continues when disk inspection fails", () =>
      Effect.gen(function* () {
        diskSpace.mockRejectedValue(new Error("statfs unavailable"));
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = yield* fixture();
        yield* maintenance.compactOnStartup(dbPath);
        assert.isFalse((yield* maintenance.inspect(dbPath)).incrementalVacuumEnabled);
      }).pipe(Effect.scoped),
    );

    it.effect("continues when another connection prevents compaction", () =>
      Effect.gen(function* () {
        ampleDisk();
        const maintenance = yield* DatabaseMaintenance.DatabaseMaintenance;
        const dbPath = yield* fixture();
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`SELECT * FROM retained`;
          yield* maintenance.compactOnStartup(dbPath);
          yield* sql`INSERT INTO retained VALUES ('startup continued')`;
        }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: dbPath })));
        assert.isFalse((yield* maintenance.inspect(dbPath)).incrementalVacuumEnabled);
      }).pipe(Effect.scoped),
    );
  },
);
