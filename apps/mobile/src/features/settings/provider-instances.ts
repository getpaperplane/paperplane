import {
  defaultInstanceIdForDriver,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type ProviderInstanceConfig,
  type ProviderInstanceMutation,
  type ServerSettings,
} from "@rove-code/contracts";
import type { ProviderClientDefinition } from "@rove-code/provider-core/client";

export interface ProviderInstanceRow {
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly isDefault: boolean;
  /** False for a default slot the user has not configured yet. */
  readonly configured: boolean;
}

/**
 * Configured instances plus the unconfigured default slot of every driver that
 * has one, so a built-in provider can be enabled before it has any settings.
 */
export function listProviderInstanceRows(
  settings: Pick<ServerSettings, "providerInstances">,
  definitions: readonly Pick<ProviderClientDefinition, "driverKind" | "hasDefaultInstance">[],
): readonly ProviderInstanceRow[] {
  const rows: ProviderInstanceRow[] = [];
  const defaultIds = new Set<string>(
    definitions.map((definition) => String(defaultInstanceIdForDriver(definition.driverKind))),
  );
  const seen = new Set<string>();
  for (const definition of definitions) {
    const id = defaultInstanceIdForDriver(definition.driverKind);
    const explicit = settings.providerInstances[id];
    if (explicit === undefined && definition.hasDefaultInstance === false) continue;
    seen.add(id);
    rows.push({
      instanceId: id,
      instance: explicit ?? { driver: definition.driverKind },
      isDefault: true,
      configured: explicit !== undefined,
    });
  }
  for (const [rawId, instance] of Object.entries(settings.providerInstances)) {
    if (seen.has(rawId)) continue;
    rows.push({
      instanceId: ProviderInstanceId.make(rawId),
      instance,
      isDefault: defaultIds.has(rawId),
      configured: true,
    });
  }
  return rows;
}

export function providerInstanceEnabledMutation(
  row: Pick<ProviderInstanceRow, "instanceId" | "instance">,
  enabled: boolean,
): ProviderInstanceMutation {
  return {
    operation: "upsert",
    instanceId: row.instanceId,
    instance: { ...row.instance, enabled },
  };
}

export interface ProviderInstanceDraft {
  readonly displayName: string;
  readonly config: Record<string, unknown> | undefined;
}

/** Applies an edit draft to an instance; an empty name or config is omitted, not stored blank. */
export function applyProviderInstanceDraft(
  instance: ProviderInstanceConfig,
  draft: ProviderInstanceDraft,
): ProviderInstanceConfig {
  const { displayName: _name, config: _config, ...rest } = instance;
  const name = draft.displayName.trim();
  const hasConfig = draft.config !== undefined && Object.keys(draft.config).length > 0;
  return {
    ...rest,
    ...(name.length > 0 ? { displayName: name } : {}),
    ...(hasConfig ? { config: draft.config } : {}),
  };
}

export function providerInstanceSaveMutation(
  row: Pick<ProviderInstanceRow, "instanceId" | "instance">,
  draft: ProviderInstanceDraft,
): ProviderInstanceMutation {
  return {
    operation: "upsert",
    instanceId: row.instanceId,
    instance: applyProviderInstanceDraft(row.instance, draft),
  };
}

export function providerInstanceCreateMutation(input: {
  readonly driver: ProviderInstanceConfig["driver"];
  readonly instanceId: string;
  readonly draft: ProviderInstanceDraft;
}): ProviderInstanceMutation {
  return {
    operation: "create",
    instanceId: ProviderInstanceId.make(input.instanceId),
    instance: applyProviderInstanceDraft({ driver: input.driver, enabled: true }, input.draft),
  };
}

export function providerInstanceLabel(
  row: Pick<ProviderInstanceRow, "instanceId" | "instance">,
  definition: Pick<ProviderClientDefinition, "label"> | undefined,
): string {
  return row.instance.displayName?.trim() || definition?.label || String(row.instance.driver);
}

export function providerInstanceEnabled(row: Pick<ProviderInstanceRow, "instance">): boolean {
  return resolveProviderInstanceEnabled(row.instance);
}
