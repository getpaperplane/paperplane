import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Neon from "alchemy/Neon";
import { adopt } from "alchemy/AdoptPolicy";
import * as Alchemy from "alchemy";
import * as RemovalPolicy from "alchemy/RemovalPolicy";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { relayNeonBranchConfig } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("paperplane-relay/db/RelayDb") {}

export class RelayTransactions extends Context.Service<
  RelayTransactions,
  {
    readonly withTransaction: RelayDb["Service"]["$client"]["withTransaction"];
  }
>()("paperplane-relay/db/RelayTransactions") {
  static readonly layer = Layer.effect(
    RelayTransactions,
    Effect.gen(function* () {
      const db = yield* RelayDb;
      return RelayTransactions.of({
        withTransaction: db.$client.withTransaction,
      });
    }),
  );
}

export const NeonDatabaseBranch = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;
  const projectId = yield* Config.NonEmptyString("NEON_PROJECT_ID");
  const productionBranch = yield* Config.NonEmptyString("NEON_PRODUCTION_BRANCH").pipe(
    Config.withDefault("production"),
  );
  // The project is created on Neon Free outside Alchemy. A project-scoped key
  // cannot create projects or change organization billing.
  const branch = Neon.Branch("RelayNeonDatabaseBranch", {
    ...relayNeonBranchConfig(stage, projectId, productionBranch),
    // Apply committed migrations. An unresolved Schema resource output here
    // prevents Alchemy from discovering an existing branch during planning.
    migrations: { dir: "./migrations/postgres", table: "relay_migrations" },
  });

  if (stage === "prod") {
    return yield* branch.pipe(adopt(true), RemovalPolicy.retain());
  }
  return yield* branch;
});

export const RelayHyperdrive = Effect.gen(function* () {
  const branch = yield* NeonDatabaseBranch;
  return yield* Cloudflare.Hyperdrive.Connection("RelayHyperdrive", {
    // Hyperdrive already pools connections; do not stack Neon's pooler behind it.
    origin: branch.origin,
    dev: branch.pooledOrigin,
    caching: {
      disabled: true,
    },
    // Cloudflare caps our plan at 20; preserve this on sync (upstream uses 40).
    originConnectionLimit: 20,
  });
});
