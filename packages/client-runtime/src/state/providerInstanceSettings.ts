import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  isSecretSetting,
  type ProjectId,
  type ProjectSettingsOverrides,
  type ProviderInstanceEnvironmentVariable,
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
  return Predicate.isString(value) ? value : undefined;
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
  // SAFETY: Settings field schemas decode `undefined` to their declared default.
  const decoded = Schema.decodeUnknownOption(fieldSchema as Schema.Decoder<unknown>)(undefined);
  return Option.isSome(decoded) && Predicate.isBoolean(decoded.value) ? decoded.value : undefined;
}

/** A driver's opaque config blob; its schema is owned by the driver's settings. */
export const ProviderConfigBlobSchema = Schema.Record(Schema.String, Schema.Unknown);
export type ProviderConfigBlob = typeof ProviderConfigBlobSchema.Type;
const isProviderConfigBlob = Schema.is(ProviderConfigBlobSchema);

export function asProviderConfigBlob(config: unknown): ProviderConfigBlob | undefined {
  return isProviderConfigBlob(config) ? config : undefined;
}

export function readProviderConfigString(config: unknown, key: string): string {
  const value = asProviderConfigBlob(config)?.[key];
  return Predicate.isString(value) ? value : "";
}

export function readProviderConfigBoolean(
  config: unknown,
  key: string,
  defaultValue = false,
): boolean {
  const value = asProviderConfigBlob(config)?.[key];
  return Predicate.isBoolean(value) ? value : defaultValue;
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

  const keyed = Object.keys(definition.settingsSchema.fields).map((key, index) => ({
    key,
    index,
  }));
  return [...keyed]
    .sort(
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

      return [buildFieldModel(key, fieldSchema, formAnnotation, isLocalAcp)];
    });
}

/** Validate editable fields with the same schemas that supply their form metadata. */
export function validateProviderSettingsConfig(
  definition: ProviderSettingsFormDefinition,
  config: unknown,
): string | null {
  const values = asProviderConfigBlob(config) ?? {};
  for (const field of deriveProviderSettingsFields(definition, config)) {
    const schema = definition.settingsSchema.fields[field.key]!;
    if (
      Option.isNone(
        Schema.decodeUnknownOption(schema as Schema.Decoder<unknown>)(values[field.key]),
      )
    ) {
      return `${field.label}: ${field.description ?? "Invalid value."}`;
    }
  }
  return null;
}

type MutableFieldModel = {
  -readonly [K in keyof ProviderSettingsFieldModel]: ProviderSettingsFieldModel[K];
};

function buildFieldModel(
  key: string,
  fieldSchema: Schema.Top,
  formAnnotation: ProviderSettingsFormAnnotation,
  isLocalAcp: boolean,
): ProviderSettingsFieldModel {
  const localCommand = isLocalAcp && key === "commandPath";
  const model: MutableFieldModel = {
    key,
    control: formAnnotation.control ?? "text",
    label: localCommand
      ? "Executable"
      : (readFieldAnnotationString(fieldSchema, "title") ?? titleizeFieldKey(key)),
    clearWhenEmpty: formAnnotation.clearWhenEmpty ?? "omit",
  };
  const description = localCommand
    ? "Executable name or path on this environment."
    : readFieldAnnotationString(fieldSchema, "description");
  if (description !== undefined) model.description = description;
  const placeholder = localCommand ? "e.g. dsh" : formAnnotation.placeholder;
  if (placeholder !== undefined) model.placeholder = placeholder;
  if (isSecretSetting(fieldSchema)) model.secret = true;
  if (formAnnotation.control === "switch") {
    model.defaultBooleanValue = readFieldBooleanDefault(fieldSchema);
  }
  if (formAnnotation.control === "select" && formAnnotation.options) {
    model.options = formAnnotation.options;
  }
  return model;
}

/** Applies one edited field to a provider config, dropping empty values the field omits. */
export function nextProviderConfigWithFieldValue(
  config: unknown,
  field: ProviderSettingsFieldModel,
  value: string | boolean,
): ProviderConfigBlob | undefined {
  const others = Object.entries(asProviderConfigBlob(config) ?? {}).filter(
    ([key]) => key !== field.key,
  );
  const omit = Predicate.isBoolean(value)
    ? field.clearWhenEmpty === "omit" && value === (field.defaultBooleanValue ?? false)
    : field.clearWhenEmpty === "omit" && value.trim().length === 0;
  const entries = omit ? others : [...others, [field.key, value] as const];
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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
) {
  return Object.fromEntries(
    projectIds.map((projectId) => {
      const current = settings.projectSettingsOverrides[projectId];
      const instances = { ...current?.providerInstances };
      const instance = { ...instances[instanceId] };
      if (value === undefined) delete instance.enabled;
      else instance.enabled = value;
      if (Object.keys(instance).length > 0) instances[instanceId] = instance;
      else delete instances[instanceId];

      const { providerInstances: _omit, ...rest } = current ?? {};
      const nextEntry: ProjectSettingsOverrides = { ...rest, providerInstances: instances };
      const empty = Object.keys(rest).length === 0 && Object.keys(instances).length === 0;
      return [projectId, empty ? null : nextEntry] as const;
    }),
  );
}

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** A blank row the user added but never filled in; it is dropped on save. */
const isBlankEnvironmentRow = (row: ProviderInstanceEnvironmentVariable) =>
  row.name.trim().length === 0 && row.value.length === 0 && row.valueRedacted === undefined;

export function newEnvironmentRow(): ProviderInstanceEnvironmentVariable {
  return { name: "", value: "", sensitive: true };
}

/** Typing a value replaces whatever the server redacted. */
export function setEnvironmentRowValue(
  row: ProviderInstanceEnvironmentVariable,
  value: string,
): ProviderInstanceEnvironmentVariable {
  const { valueRedacted: _redacted, ...rest } = row;
  return { ...rest, value };
}

/** Making a row visible discards a redacted value, which the client never held. */
export function setEnvironmentRowSensitive(
  row: ProviderInstanceEnvironmentVariable,
  sensitive: boolean,
): ProviderInstanceEnvironmentVariable {
  if (sensitive || row.valueRedacted !== true) return { ...row, sensitive };
  const { valueRedacted: _redacted, ...rest } = row;
  return { ...rest, sensitive, value: "" };
}

/** Rejects names the server would, and duplicates that would silently shadow each other. */
export function validateProviderEnvironment(
  rows: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): string | null {
  const seen = new Set<string>();
  for (const row of rows) {
    if (isBlankEnvironmentRow(row)) continue;
    const name = row.name.trim();
    if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
      return `"${name}" is not a valid variable name. Use letters, digits and underscores, not starting with a digit.`;
    }
    if (seen.has(name)) return `Variable ${name} is listed more than once.`;
    seen.add(name);
  }
  return null;
}

/** The rows to persist: trimmed names, blank rows removed, redacted values kept as-is. */
export function finalizeProviderEnvironment(
  rows: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return rows
    .filter((row) => !isBlankEnvironmentRow(row))
    .map((row) => ({ ...row, name: row.name.trim() }));
}

export function readProviderCommandArgs(config: unknown): ReadonlyArray<string> {
  const value = asProviderConfigBlob(config)?.commandArgs;
  return Array.isArray(value) ? value.filter(Predicate.isString) : [];
}

/** Replaces `commandArgs`, preserving every other (including hidden) config field. */
export function withProviderCommandArgs(
  config: unknown,
  args: ReadonlyArray<string>,
): ProviderConfigBlob {
  return { ...asProviderConfigBlob(config), commandArgs: [...args] };
}

/**
 * Why an ACP Registry instance cannot start yet, or null. A registry agent needs
 * its id (and a prepared install); a local one needs an executable.
 */
export function validateAcpRegistryConfig(config: unknown): string | null {
  if (readProviderConfigString(config, "source") === "local") {
    return readProviderConfigString(config, "commandPath").trim().length > 0
      ? null
      : "Enter the executable to run on the environment.";
  }
  return readProviderConfigString(config, "agentId").trim().length > 0
    ? null
    : "Choose an agent from the ACP Registry, or use a local command.";
}

export function readProviderEnvironmentVariable(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  name: string,
): ProviderInstanceEnvironmentVariable | undefined {
  return environment?.find((variable) => variable.name === name);
}

export function providerEnvironmentWithoutNames(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  names: ReadonlySet<string>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return (environment ?? []).filter((variable) => !names.has(variable.name));
}

export function nextProviderEnvironmentWithFieldValue(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  field: ProviderEnvironmentFieldLike,
  value: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const trimmed = value.trim();
  const next: ProviderInstanceEnvironmentVariable[] = [];
  let found = false;

  for (const variable of environment ?? []) {
    if (variable.name !== field.name) {
      next.push(variable);
      continue;
    }
    found = true;
    if (trimmed.length > 0) {
      next.push({
        name: variable.name,
        value: trimmed,
        sensitive: field.sensitive ?? true,
      });
    }
  }

  if (!found && trimmed.length > 0) {
    next.push({
      name: field.name,
      value: trimmed,
      sensitive: field.sensitive ?? true,
    });
  }

  return next;
}

/** The part of a driver's environment field the helpers need. */
export interface ProviderEnvironmentFieldLike {
  readonly name: string;
  readonly label?: string | undefined;
  readonly sensitive?: boolean | undefined;
}
