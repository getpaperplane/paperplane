import Constants from "expo-constants";
import { relayClerkTokenOptions } from "@rove-code/shared/relayAuth";
import { normalizeSecureRelayUrl } from "@rove-code/shared/relayUrl";
import * as Schema from "effect/Schema";
import * as RuntimePredicate from "effect/Predicate";

export class CloudPublicConfigMissingError extends Schema.TaggedError<CloudPublicConfigMissingError>()(
  "CloudPublicConfigMissingError",
  {
    key: Schema.Literal("ROVE_CLERK_JWT_TEMPLATE"),
  },
) {
  override get message(): string {
    return `${this.key} is not configured.`;
  }
}

export interface CloudPublicConfig {
  readonly clerk: {
    readonly publishableKey: string | null;
    readonly jwtTemplate: string | null;
  };
  readonly relay: {
    readonly url: string | null;
  };
  readonly observability: {
    readonly tracesUrl: string | null;
    readonly tracesDataset: string | null;
    readonly tracesToken: string | null;
  };
}

type UntrustedSection<T> = {
  readonly [Key in keyof T]?: Schema.Json;
};

type ExpoExtra =
  | ({
      readonly [Section in keyof CloudPublicConfig]?: UntrustedSection<CloudPublicConfig[Section]>;
    } & { readonly cloudReady?: Schema.Json })
  | undefined;

function trimNonEmpty(value: unknown): string | null {
  return RuntimePredicate.isString(value) && value.trim() ? value.trim() : null;
}

function normalizeSecureUrl(value: unknown): string | null {
  const raw = trimNonEmpty(value);
  if (raw === null) {
    return null;
  }
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function resolveCloudPublicConfig(extra: ExpoExtra = Constants.expoConfig?.extra) {
  const cloudReady = extra?.cloudReady === true;
  return {
    clerk: {
      publishableKey: cloudReady ? trimNonEmpty(extra?.clerk?.publishableKey) : null,
      jwtTemplate: cloudReady ? trimNonEmpty(extra?.clerk?.jwtTemplate) : null,
    },
    relay: {
      url: cloudReady ? normalizeSecureRelayUrl(trimNonEmpty(extra?.relay?.url) ?? "") : null,
    },
    observability: {
      tracesUrl: normalizeSecureUrl(extra?.observability?.tracesUrl),
      tracesDataset: trimNonEmpty(extra?.observability?.tracesDataset),
      tracesToken: trimNonEmpty(extra?.observability?.tracesToken),
    },
  } satisfies CloudPublicConfig;
}

export function hasCloudPublicConfig(): boolean {
  const config = resolveCloudPublicConfig();
  return Boolean(config.clerk.publishableKey && config.clerk.jwtTemplate && config.relay.url);
}

type Configured<T> = {
  readonly [Key in keyof T]: NonNullable<T[Key]>;
};

type TracingPublicConfig = Omit<CloudPublicConfig, "observability"> & {
  readonly observability: Configured<CloudPublicConfig["observability"]>;
};

export function hasTracingPublicConfig(
  config: CloudPublicConfig = resolveCloudPublicConfig(),
): config is TracingPublicConfig {
  return Boolean(
    config.observability.tracesUrl &&
    config.observability.tracesDataset &&
    config.observability.tracesToken,
  );
}

export function resolveRelayClerkTokenOptions() {
  const { jwtTemplate } = resolveCloudPublicConfig().clerk;
  if (!jwtTemplate) {
    throw new CloudPublicConfigMissingError({ key: "ROVE_CLERK_JWT_TEMPLATE" });
  }
  return relayClerkTokenOptions(jwtTemplate);
}
