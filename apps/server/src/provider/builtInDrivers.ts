/**
 * BUILT_IN_DRIVERS — the static set of `ProviderDriver`s this build ships
 * with.
 *
 * Every driver that the server knows how to instantiate from settings is
 * listed here. The `ProviderInstanceRegistry` iterates this array when
 * resolving `providerInstances` entries; anything not in the array surfaces
 * as an `"unavailable"` shadow snapshot at runtime (see
 * `buildUnavailableProviderSnapshot`).
 *
 * Adding a new first-party driver means:
 *   1. implement `ProviderDriver` in a sibling `Drivers/<Name>Driver.ts`,
 *   2. add it to this array,
 *   3. ensure the runtime layer satisfies its declared `R`.
 *
 * The aggregated `BuiltInDriversEnv` type is the union of every driver's
 * env requirement — the registry layer's `R` is this type, and the runtime
 * layer (ChildProcessSpawner, FileSystem, Path, ServerConfig,
 * OpenCodeRuntime, …) must satisfy it.
 *
 * @module provider/builtInDrivers
 */
import {
  AcpRegistryDriver,
  type AcpRegistryDriverEnv,
} from "@rove-code/provider-acp-registry/server";
import { AntigravityDriver, type AntigravityDriverEnv } from "./Drivers/AntigravityDriver.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "./Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "./Drivers/CodexDriver.ts";
import { CursorDriver, type CursorDriverEnv } from "@rove-code/provider-cursor/server";
import { GrokDriver, type GrokDriverEnv } from "@rove-code/provider-grok/server";
import { OpenCodeDriver, type OpenCodeDriverEnv } from "@rove-code/provider-opencode/server";
import { MuseDriver, type MuseDriverEnv } from "@rove-code/provider-muse/server";
import { PiDriver, type PiDriverEnv } from "./Drivers/PiDriver.ts";
import { piUsageFormat } from "@rove-code/provider-pi/server/usage";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HostProcess from "@rove-code/shared/HostProcess";
import { expandHomePath } from "@rove-code/provider-core/server/pathExpansion";
import type { ProviderUsageInstance } from "@rove-code/provider-core/server/usage";
import type {
  AnyProviderDriver,
  ProviderUsageReaderEnv,
} from "@rove-code/provider-core/server/driver";

/**
 * Union of infrastructure services required to construct any built-in
 * driver. The registry layer declares `R = BuiltInDriversEnv`; the runtime
 * layer must provide every service in this union.
 */
export type BuiltInDriversEnv =
  | AcpRegistryDriverEnv
  | AntigravityDriverEnv
  | ClaudeDriverEnv
  | CodexDriverEnv
  | CursorDriverEnv
  | GrokDriverEnv
  | OpenCodeDriverEnv
  | PiDriverEnv
  | MuseDriverEnv;

/**
 * Ordered list of built-in drivers. Order matters only for tie-breaking in
 * UI presentation — the registry itself is keyed by `driverKind`, so
 * iteration order has no functional effect on instance lookup.
 */
export const BUILT_IN_DRIVERS: ReadonlyArray<AnyProviderDriver<BuiltInDriversEnv>> = [
  CodexDriver,
  ClaudeDriver,
  CursorDriver,
  GrokDriver,
  OpenCodeDriver,
  AntigravityDriver,
  PiDriver,
  MuseDriver,
  AcpRegistryDriver,
];

/** Native Pi's SDK settings own its agent directory. */
export const resolvePiUsageAgentDir = Effect.fn("resolvePiUsageAgentDir")(function* (
  instance: Pick<ProviderUsageInstance<{ readonly agentDir?: string }>, "config" | "environment">,
) {
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const configured =
    instance.config?.agentDir?.trim() || instance.environment.PI_CODING_AGENT_DIR?.trim();
  return path.resolve(
    configured ? expandHomePath(configured, home) : path.join(home, ".pi", "agent"),
  );
});

const PiUsageCost = Schema.Struct({
  input: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  cacheRead: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  total: Schema.optional(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
});
const PiUsageSavingsEntry = Schema.Struct({
  usage: Schema.optional(Schema.Struct({ cost: Schema.optional(PiUsageCost) })),
  message: Schema.optional(
    Schema.Struct({
      usage: Schema.optional(Schema.Struct({ cost: Schema.optional(PiUsageCost) })),
    }),
  ),
});
const decodePiUsageSavings = Schema.decodeUnknownOption(PiUsageSavingsEntry);

const parseNativePiUsage = (
  parsed: unknown,
  state: Parameters<typeof piUsageFormat.parseProjected>[1],
) => {
  const records = piUsageFormat.parseProjected(parsed, state);
  if (records.length === 0) return records;
  const entry = Option.getOrUndefined(decodePiUsageSavings(parsed));
  const cost = entry?.message?.usage?.cost ?? entry?.usage?.cost;
  if (cost?.input === undefined || cost.cacheRead === undefined || !(cost.total && cost.total > 0))
    return records;
  const inputCost = cost.input;
  const cacheReadCost = cost.cacheRead;
  return records.map((record) =>
    record.totals.uncachedInputTokens > 0
      ? {
          ...record,
          reportedCacheSavingsUsd:
            record.totals.cachedInputTokens * (inputCost / record.totals.uncachedInputTokens) -
            cacheReadCost,
        }
      : record,
  );
};

// Reuse only the independent transcript format; Pi sessions still run through the native SDK driver.
const nativePiUsageFormat = {
  ...piUsageFormat,
  parseProjected: parseNativePiUsage,
  parseLine: (line: string, state: Parameters<typeof piUsageFormat.parseProjected>[1]) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseNativePiUsage(parsed, state);
  },
};

const PiUsageDriver = {
  driverKind: PiDriver.driverKind,
  configSchema: Schema.Struct({ agentDir: Schema.optional(Schema.String) }),
  usage: {
    kind: "transcripts" as const,
    provider: "pi" as const,
    format: nativePiUsageFormat,
    directories: Effect.fn("PiUsageDriver.directories")(function* (
      instance: ProviderUsageInstance<{ readonly agentDir?: string }>,
    ) {
      const path = yield* Path.Path;
      const home = yield* HostProcess.HomeDirectory;
      const sessionDir = instance.environment.PI_CODING_AGENT_SESSION_DIR?.trim();
      return [
        {
          dir: sessionDir
            ? path.resolve(expandHomePath(sessionDir, home))
            : path.join(yield* resolvePiUsageAgentDir(instance), "sessions"),
        },
      ];
    }),
  },
};

/** Services the built-in usage readers need. */
export type BuiltInUsageReadersEnv =
  | ProviderUsageReaderEnv<typeof ClaudeDriver>
  | ProviderUsageReaderEnv<typeof CodexDriver>
  | ProviderUsageReaderEnv<typeof GrokDriver>
  | ProviderUsageReaderEnv<typeof OpenCodeDriver>
  | ProviderUsageReaderEnv<typeof AntigravityDriver>
  | ProviderUsageReaderEnv<typeof CursorDriver>
  | Path.Path;

/**
 * The drivers that keep usage history, in the order the usage page reads
 * them: transcript readers first, then scan readers. Aggregation keeps the
 * first copy of a duplicate record, so the order is part of the result.
 */
export const BUILT_IN_USAGE_DRIVERS: ReadonlyArray<
  Pick<
    AnyProviderDriver<BuiltInDriversEnv, BuiltInUsageReadersEnv>,
    "driverKind" | "configSchema" | "usage"
  >
> = [
  ClaudeDriver,
  CodexDriver,
  GrokDriver,
  PiUsageDriver,
  OpenCodeDriver,
  AntigravityDriver,
  CursorDriver,
];
