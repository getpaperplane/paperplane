import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  isSecretSetting,
  type ProjectId,
  type ProjectSettingsOverrides,
  type ProviderInstanceId,
  type ProviderSettingsFormAnnotation,
  type ProviderSettingsFormControl,
  type ProviderSettingsFormOption,
  type ProviderSettingsFormSchemaAnnotation,
  type ServerSettings,
} from "@rove-code/contracts";

/** What the settings form reads from a provider client definition. */
export interface ProviderSettingsFormDefinition {
  readonly driverKind?: string | undefined;
  readonly settingsSchema: {
    readonly fields: Readonly<Record<string, Schema.Top>>;
  } & Schema.Top;
}

export interface ProviderSettingsFieldModel {
  readonly key: string;
  readonly control: ProviderSettingsFormControl;
  readonly label: string;
  readonly description?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly clearWhenEmpty: "omit" | "persist";
  /** Kept in the server's secret store: a saved value arrives redacted and never shows. */
  readonly secret?: boolean | undefined;
  readonly defaultBooleanValue?: boolean | undefined;
  /** Choices for a `select` control. The first entry is the default. */
  readonly options?: ReadonlyArray<ProviderSettingsFormOption> | undefined;
}

function titleizeFieldKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function readFieldAnnotations(fieldSchema: Schema.Top) {
  return Schema.resolveAnnotationsKey(fieldSchema) ?? Schema.resolveAnnotations(fieldSchema);
}

function readFieldAnnotationString(
  fieldSchema: Schema.Top,
  key: "title" | "description",
): string | undefined {
  const value = readFieldAnnotations(fieldSchema)?.[key];
  return typeof value === "string" ? value : undefined;
}

function readProviderSettingsFormAnnotation(
  fieldSchema: Schema.Top,
): ProviderSettingsFormAnnotation {
  return readFieldAnnotations(fieldSchema)?.providerSettingsForm ?? {};
}

function readProviderSettingsFormSchemaAnnotation(
  definition: ProviderSettingsFormDefinition,
): ProviderSettingsFormSchemaAnnotation {
  return Schema.resolveAnnotations(definition.settingsSchema)?.providerSettingsFormSchema ?? {};
}

function readFieldBooleanDefault(fieldSchema: Schema.Top): boolean | undefined {
  const decoded = Schema.decodeUnknownOption(fieldSchema as Schema.Decoder<unknown>)(undefined);
  return Option.isSome(decoded) && typeof decoded.value === "boolean" ? decoded.value : undefined;
}

export function readProviderConfigString(config: unknown, key: string): string {
  if (config === null || typeof config !== "object") return "";
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

export function readProviderConfigBoolean(
  config: unknown,
  key: string,
  defaultValue = false,
): boolean {
  if (config === null || typeof config !== "object") return defaultValue;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : defaultValue;
}

/**
 * The visible settings fields of a driver, in presentation order. Pi's workload
 * fields are hidden unless the host advertises `piWorkloadProtection`.
 */
export function deriveProviderSettingsFields(
  definition: ProviderSettingsFormDefinition,
  value?: unknown,
  supportsPiWorkloadProtection = true,
): ReadonlyArray<ProviderSettingsFieldModel> {
  const isLocalAcp =
    definition.driverKind === "acpRegistry" &&
    readProviderConfigString(value, "source") === "local";
  const schemaAnnotation = readProviderSettingsFormSchemaAnnotation(definition);
  const orderedKeys = new Map(
    (schemaAnnotation.order ?? []).map((key, index) => [key, index] as const),
  );
  const orderFallbackOffset = orderedKeys.size;

  return Object.keys(definition.settingsSchema.fields)
    .map((key, index) => ({ key, index }))
    .toSorted(
      (left, right) =>
        (orderedKeys.get(left.key) ?? orderFallbackOffset + left.index) -
        (orderedKeys.get(right.key) ?? orderFallbackOffset + right.index),
    )
    .flatMap(({ key }) => {
      const fieldSchema = definition.settingsSchema.fields[key]!;
      const formAnnotation = readProviderSettingsFormAnnotation(fieldSchema);
      if (formAnnotation.hidden) return [];
      if (isLocalAcp && key !== "source" && key !== "commandPath") return [];
      if (
        definition.driverKind === "pi" &&
        !supportsPiWorkloadProtection &&
        (key === "workloadProtection" || key === "workloadMemoryMiB")
      )
        return [];

      const annotatedTitle = readFieldAnnotationString(fieldSchema, "title");
      const annotatedDescription = readFieldAnnotationString(fieldSchema, "description");
      return [
        {
          key,
          control: formAnnotation.control ?? "text",
          label:
            isLocalAcp && key === "commandPath"
              ? "Executable"
              : (annotatedTitle ?? titleizeFieldKey(key)),
          ...(isLocalAcp && key === "commandPath"
            ? { description: "Executable name or path on this environment." }
            : annotatedDescription !== undefined
              ? { description: annotatedDescription }
              : {}),
          ...(isLocalAcp && key === "commandPath"
            ? { placeholder: "e.g. dsh" }
            : formAnnotation.placeholder !== undefined
              ? { placeholder: formAnnotation.placeholder }
              : {}),
          clearWhenEmpty: formAnnotation.clearWhenEmpty ?? "omit",
          ...(isSecretSetting(fieldSchema) ? { secret: true } : {}),
          ...(formAnnotation.control === "switch"
            ? { defaultBooleanValue: readFieldBooleanDefault(fieldSchema) }
            : {}),
          ...(formAnnotation.control === "select" && formAnnotation.options
            ? { options: formAnnotation.options }
            : {}),
        } satisfies ProviderSettingsFieldModel,
      ];
    });
}

/** Applies one edited field to a provider config, dropping empty values the field omits. */
export function nextProviderConfigWithFieldValue(
  config: unknown,
  field: ProviderSettingsFieldModel,
  value: string | boolean,
): Record<string, unknown> | undefined {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};

  if (typeof value === "boolean") {
    const emptyBooleanValue = field.defaultBooleanValue ?? false;
    if (field.clearWhenEmpty === "omit" && value === emptyBooleanValue) {
      delete base[field.key];
    } else {
      base[field.key] = value;
    }
    return Object.keys(base).length > 0 ? base : undefined;
  }

  if (field.clearWhenEmpty === "omit" && value.trim().length === 0) {
    delete base[field.key];
  } else {
    base[field.key] = value;
  }
  return Object.keys(base).length > 0 ? base : undefined;
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** `<driver>_<slug>` for a label, or "" when the label has no usable characters. */
export function deriveProviderInstanceId(driver: string, label: string): string {
  const slug = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48);
  return slug ? `${driver}_${slug}` : "";
}

/** Mirrors the server's `ProviderInstanceId` slug rules. Returns a user-facing error or null. */
export function validateProviderInstanceId(
  id: string,
  existing: ReadonlySet<string>,
): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

/** Writes one project-level enabled choice for every checkout of a project. */
export function buildProviderInstanceOverridePatch(
  settings: Pick<ServerSettings, "projectSettingsOverrides">,
  projectIds: readonly ProjectId[],
  instanceId: ProviderInstanceId,
  value: boolean | undefined,
): Record<ProjectId, ProjectSettingsOverrides | null> {
  const patch: Record<ProjectId, ProjectSettingsOverrides | null> = {};
  for (const projectId of projectIds) {
    const current = settings.projectSettingsOverrides[projectId];
    const instances = { ...current?.providerInstances };
    const instance = { ...instances[instanceId] };
    if (value === undefined) delete instance.enabled;
    else instance.enabled = value;
    if (Object.keys(instance).length > 0) instances[instanceId] = instance;
    else delete instances[instanceId];

    const { providerInstances: _omit, ...rest } = current ?? {};
    const nextEntry: ProjectSettingsOverrides = { ...rest, providerInstances: instances };
    patch[projectId] =
      Object.keys(rest).length === 0 && Object.keys(instances).length === 0 ? null : nextEntry;
  }
  return patch;
}
