import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@rove-code/client-runtime/state/runtime";
import {
  buildProviderInstanceOverridePatch,
  deriveProviderInstanceId,
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
  validateProviderInstanceId,
  type ProviderSettingsFieldModel,
} from "@rove-code/client-runtime/state/provider-instance-settings";
import {
  resolveProjectProviderInstanceEnabled,
  type ProjectId,
  type ProviderInstanceMutation,
} from "@rove-code/contracts";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { getProviderClient, providerClientDefinitions } from "../../../lib/providerClients";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  listProviderInstanceRows,
  providerInstanceCreateMutation,
  providerInstanceEnabled,
  providerInstanceEnabledMutation,
  providerInstanceLabel,
  providerInstanceSaveMutation,
  type ProviderInstanceRow,
} from "../provider-instances";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const FIELD_CLASS = "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";

function useProviderInstanceMutation(environmentId: SettingsTarget["environmentId"]) {
  const update = useAtomCommand(serverEnvironment.mutateProviderInstance, {
    reportFailure: false,
    reportDefect: false,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(mutation: ProviderInstanceMutation) {
    if (pending) return false;
    setPending(true);
    setError(null);
    let ok = false;
    try {
      const result = (await update({
        environmentId,
        input: { patch: {}, providerInstanceMutation: mutation },
      })) as AtomCommandResult<unknown, unknown>;
      if (result._tag === "Success") ok = true;
      else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not update provider.");
      }
    } catch {
      setError("Could not update provider.");
    }
    setPending(false);
    return ok;
  }
  return { run, pending, error };
}

function FieldInputs(props: {
  readonly fields: ReadonlyArray<ProviderSettingsFieldModel>;
  readonly config: Record<string, unknown> | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: Record<string, unknown> | undefined) => void;
}) {
  return (
    <>
      {props.fields.map((field) => {
        if (field.control === "switch") {
          return (
            <SettingsSwitchRow
              key={field.key}
              label={field.label}
              subtitle={field.description}
              disabled={props.disabled}
              value={readProviderConfigBoolean(props.config, field.key, field.defaultBooleanValue)}
              onValueChange={(value) =>
                props.onChange(nextProviderConfigWithFieldValue(props.config, field, value))
              }
            />
          );
        }
        if (field.control === "select") {
          const options = field.options ?? [];
          const fallback = options[0]?.value ?? "";
          const current = readProviderConfigString(props.config, field.key) || fallback;
          return (
            <View key={field.key}>
              <Text className="px-4 pt-3 text-sm text-foreground-muted">{field.label}</Text>
              {options.map((option) => (
                <SettingsChoiceRow
                  key={option.value}
                  label={option.label}
                  selected={option.value === current}
                  disabled={props.disabled}
                  onPress={() =>
                    props.onChange(
                      nextProviderConfigWithFieldValue(
                        props.config,
                        field,
                        option.value === fallback ? "" : option.value,
                      ),
                    )
                  }
                />
              ))}
            </View>
          );
        }
        // A saved secret arrives redacted; show an empty box and only replace it on input.
        const configured = field.secret && readProviderConfigString(props.config, field.key) !== "";
        const secret = field.secret || field.control === "password";
        return (
          <View key={field.key} className="gap-1 px-4 py-2">
            <Text className="text-sm text-foreground-muted">{field.label}</Text>
            <TextInput
              accessibilityLabel={field.label}
              className={FIELD_CLASS}
              placeholderTextColorClassName="accent-foreground-muted"
              placeholder={
                configured ? "Saved. Enter a new value to replace." : (field.placeholder ?? "")
              }
              secureTextEntry={secret}
              autoCapitalize="none"
              autoCorrect={false}
              editable={!props.disabled}
              multiline={field.control === "textarea"}
              defaultValue={field.secret ? "" : readProviderConfigString(props.config, field.key)}
              onChangeText={(value) => {
                if (field.secret && value === "") return;
                props.onChange(nextProviderConfigWithFieldValue(props.config, field, value));
              }}
            />
            {field.description ? (
              <Text className="text-xs text-foreground-muted">{field.description}</Text>
            ) : null}
          </View>
        );
      })}
    </>
  );
}

function InstanceEditor(props: {
  readonly environment: SettingsTarget;
  readonly row: ProviderInstanceRow;
  readonly supportsPiWorkloadProtection: boolean;
  readonly onDone: () => void;
}) {
  const { environment, row } = props;
  const mutation = useProviderInstanceMutation(environment.environmentId);
  const definition = getProviderClient(row.instance.driver);
  const [displayName, setDisplayName] = useState(row.instance.displayName ?? "");
  const [config, setConfig] = useState(
    row.instance.config !== null && typeof row.instance.config === "object"
      ? (row.instance.config as Record<string, unknown>)
      : undefined,
  );
  const fields = definition
    ? deriveProviderSettingsFields(definition, config, props.supportsPiWorkloadProtection)
    : [];
  return (
    <View className="gap-1 border-t border-border-subtle py-2">
      <View className="gap-1 px-4 py-2">
        <Text className="text-sm text-foreground-muted">Name</Text>
        <TextInput
          accessibilityLabel="Name"
          className={FIELD_CLASS}
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder={definition?.label ?? String(row.instance.driver)}
          value={displayName}
          onChangeText={setDisplayName}
          editable={!mutation.pending}
        />
      </View>
      <FieldInputs
        fields={fields}
        config={config}
        disabled={mutation.pending}
        onChange={setConfig}
      />
      {mutation.error ? (
        <Text accessibilityRole="alert" className="px-4 text-danger-foreground">
          {mutation.error}
        </Text>
      ) : null}
      <SettingsActionRow
        icon="checkmark"
        label="Save"
        loading={mutation.pending}
        onPress={() => {
          void mutation
            .run(providerInstanceSaveMutation(row, { displayName, config }))
            .then((ok) => ok && props.onDone());
        }}
      />
      {row.isDefault && row.configured ? (
        <SettingsActionRow
          icon="arrow.clockwise"
          label="Reset to defaults"
          tone="danger"
          disabled={mutation.pending}
          onPress={() => {
            void mutation
              .run({ operation: "remove", instanceId: row.instanceId })
              .then((ok) => ok && props.onDone());
          }}
        />
      ) : !row.isDefault ? (
        <SettingsActionRow
          icon="trash"
          label="Delete instance"
          tone="danger"
          disabled={mutation.pending}
          onPress={() => {
            void mutation
              .run({ operation: "remove", instanceId: row.instanceId })
              .then((ok) => ok && props.onDone());
          }}
        />
      ) : null}
      <SettingsActionRow icon="xmark" label="Cancel" onPress={props.onDone} />
    </View>
  );
}

function AddInstance(props: {
  readonly environment: SettingsTarget;
  readonly existingIds: ReadonlySet<string>;
  readonly supportsPiWorkloadProtection: boolean;
  readonly onDone: () => void;
}) {
  const mutation = useProviderInstanceMutation(props.environment.environmentId);
  const [driver, setDriver] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [idOverride, setIdOverride] = useState<string | null>(null);
  const [config, setConfig] = useState<Record<string, unknown> | undefined>(undefined);
  const [attempted, setAttempted] = useState(false);
  const definition = providerClientDefinitions.find((entry) => entry.driverKind === driver);
  if (!definition) {
    return (
      <View>
        {providerClientDefinitions.map((entry) => (
          <SettingsChoiceRow
            key={entry.driverKind}
            label={entry.label}
            selected={false}
            onPress={() => setDriver(entry.driverKind)}
          />
        ))}
        <SettingsActionRow icon="xmark" label="Cancel" onPress={props.onDone} />
      </View>
    );
  }
  const instanceId = idOverride ?? deriveProviderInstanceId(definition.driverKind, displayName);
  const idError = validateProviderInstanceId(instanceId, props.existingIds);
  const fields = deriveProviderSettingsFields(
    definition,
    config,
    props.supportsPiWorkloadProtection,
  );
  return (
    <View className="gap-1 py-2">
      <Text className="px-4 text-base font-semibold text-foreground">{definition.label}</Text>
      <View className="gap-1 px-4 py-2">
        <Text className="text-sm text-foreground-muted">Name</Text>
        <TextInput
          accessibilityLabel="Name"
          className={FIELD_CLASS}
          placeholderTextColorClassName="accent-foreground-muted"
          placeholder="e.g. Work"
          value={displayName}
          onChangeText={setDisplayName}
          editable={!mutation.pending}
        />
        <Text className="pt-2 text-sm text-foreground-muted">Instance ID</Text>
        <TextInput
          accessibilityLabel="Instance ID"
          className={FIELD_CLASS}
          autoCapitalize="none"
          autoCorrect={false}
          value={instanceId}
          onChangeText={setIdOverride}
          editable={!mutation.pending}
        />
        {attempted && idError ? (
          <Text accessibilityRole="alert" className="text-danger-foreground">
            {idError}
          </Text>
        ) : null}
      </View>
      <FieldInputs
        fields={fields}
        config={config}
        disabled={mutation.pending}
        onChange={setConfig}
      />
      {mutation.error ? (
        <Text accessibilityRole="alert" className="px-4 text-danger-foreground">
          {mutation.error}
        </Text>
      ) : null}
      <SettingsActionRow
        icon="plus"
        label="Add provider"
        loading={mutation.pending}
        onPress={() => {
          setAttempted(true);
          if (idError) return;
          void mutation
            .run(
              providerInstanceCreateMutation({
                driver: definition.driverKind,
                instanceId,
                draft: { displayName, config },
              }),
            )
            .then((ok) => ok && props.onDone());
        }}
      />
      <SettingsActionRow icon="xmark" label="Cancel" onPress={props.onDone} />
    </View>
  );
}

/** Provider-instance administration for one environment. Writes need `providers:manage`. */
export function ProviderInstanceAdmin(props: { readonly environment: SettingsTarget }) {
  const { environment } = props;
  const environmentId = environment.environmentId;
  const settings = environment.serverConfig.settings;
  const capabilities = environment.serverConfig.environment.capabilities;
  const supportsPiWorkloadProtection =
    "piWorkloadProtection" in capabilities && capabilities.piWorkloadProtection === true;
  const canManage = useAtomValue(
    serverEnvironment.mutateProviderInstance.permissionAtom(environmentId),
  );
  const toggle = useProviderInstanceMutation(environmentId);
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const rows = listProviderInstanceRows(settings, providerClientDefinitions);
  const existingIds = new Set(Object.keys(settings.providerInstances));
  return (
    <View>
      {!canManage ? (
        <Text className="px-4 pt-3 text-sm text-foreground-muted">
          This session cannot manage providers on this environment.
        </Text>
      ) : null}
      {rows.map((row) => (
        <View key={row.instanceId}>
          <SettingsSwitchRow
            label={providerInstanceLabel(row, getProviderClient(row.instance.driver))}
            subtitle={row.instanceId}
            disabled={!canManage || toggle.pending}
            value={providerInstanceEnabled(row)}
            onValueChange={(enabled) => {
              void toggle.run(providerInstanceEnabledMutation(row, enabled));
            }}
          />
          {editing === row.instanceId ? (
            <InstanceEditor
              environment={environment}
              row={row}
              supportsPiWorkloadProtection={supportsPiWorkloadProtection}
              onDone={() => setEditing(null)}
            />
          ) : canManage ? (
            <SettingsActionRow
              icon="slider.horizontal.3"
              label={`Edit ${providerInstanceLabel(row, getProviderClient(row.instance.driver))}`}
              onPress={() => {
                setAdding(false);
                setEditing(row.instanceId);
              }}
            />
          ) : null}
        </View>
      ))}
      {toggle.error ? (
        <Text accessibilityRole="alert" className="px-4 py-2 text-danger-foreground">
          {toggle.error}
        </Text>
      ) : null}
      {adding ? (
        <AddInstance
          environment={environment}
          existingIds={existingIds}
          supportsPiWorkloadProtection={supportsPiWorkloadProtection}
          onDone={() => setAdding(false)}
        />
      ) : canManage ? (
        <SettingsActionRow
          icon="plus"
          label="Add provider instance"
          onPress={() => {
            setEditing(null);
            setAdding(true);
          }}
        />
      ) : null}
    </View>
  );
}

/** Per-project enable/disable of provider instances, written to every checkout of the project. */
export function ProjectProviderOverrides(props: {
  readonly environment: SettingsTarget;
  readonly projectIds: readonly ProjectId[];
  readonly projectLabel: string;
}) {
  const { environment, projectIds } = props;
  const environmentId = environment.environmentId;
  const settings = environment.serverConfig.settings;
  const supported =
    environment.serverConfig.environment.capabilities.projectProviderInstanceOverrides === true;
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: true,
    label: "project provider override",
  });
  const [pending, setPending] = useState(false);
  const representative = projectIds[0];
  if (!supported) {
    return (
      <Text className="px-4 py-3 text-sm text-foreground-muted">
        Update this environment to edit project provider overrides.
      </Text>
    );
  }
  if (representative === undefined) return null;
  const rows = listProviderInstanceRows(settings, providerClientDefinitions);
  async function write(row: ProviderInstanceRow, value: boolean | undefined) {
    if (pending) return;
    setPending(true);
    try {
      await update({
        environmentId,
        input: {
          patch: {
            projectSettingsOverrides: buildProviderInstanceOverridePatch(
              settings,
              projectIds,
              row.instanceId,
              value,
            ),
          },
        },
      });
    } finally {
      setPending(false);
    }
  }
  return (
    <View>
      {rows.map((row) => {
        const override =
          settings.projectSettingsOverrides[representative]?.providerInstances?.[row.instanceId]
            ?.enabled;
        const effective = resolveProjectProviderInstanceEnabled(
          settings,
          representative,
          row.instanceId,
        );
        return (
          <View key={row.instanceId}>
            <SettingsSwitchRow
              label={providerInstanceLabel(row, getProviderClient(row.instance.driver))}
              subtitle={override === undefined ? "Using environment default" : "Project override"}
              disabled={!canWrite || pending}
              value={effective}
              onValueChange={(next) => void write(row, next)}
            />
            {override !== undefined && canWrite ? (
              <SettingsActionRow
                icon="arrow.clockwise"
                label="Use environment default"
                disabled={pending}
                onPress={() => void write(row, undefined)}
              />
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
