import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@getpaperplane/client-runtime/state/runtime";
import {
  asProviderConfigBlob,
  buildProviderInstanceOverridePatch,
  deriveProviderInstanceId,
  deriveProviderSettingsFields,
  newEnvironmentRow,
  nextProviderConfigWithFieldValue,
  nextProviderEnvironmentWithFieldValue,
  readProviderCommandArgs,
  readProviderConfigBoolean,
  readProviderConfigString,
  readProviderEnvironmentVariable,
  setEnvironmentRowSensitive,
  setEnvironmentRowValue,
  validateAcpRegistryConfig,
  validateProviderEnvironment,
  validateProviderSettingsConfig,
  validateProviderInstanceId,
  withProviderCommandArgs,
  type ProviderConfigBlob,
  type ProviderSettingsFieldModel,
} from "@getpaperplane/client-runtime/state/provider-instance-settings";
import {
  resolveProjectProviderInstanceEnabled,
  type AcpRegistrySearchAgent,
  type ProjectId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceMutation,
} from "@getpaperplane/contracts";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import * as Dialog from "../../../components/ui/Dialog";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { getProviderClient, providerClientDefinitions } from "../../../lib/providerClients";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import {
  draftFromProviderInstance,
  nextProviderDraftConfigWithFieldValue,
  providerDraftChanged,
  type ProviderInstanceDraft,
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
      const result = await update({
        environmentId,
        input: { patch: {}, providerInstanceMutation: mutation },
      });
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
  readonly config: ProviderConfigBlob | undefined;
  readonly initialConfig: ProviderConfigBlob | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: ProviderConfigBlob | undefined) => void;
}) {
  const [secrets, setSecrets] = useState<Record<string, string>>({});
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
                props.onChange(
                  asProviderConfigBlob(
                    nextProviderConfigWithFieldValue(props.config, field, value),
                  ),
                )
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
                      asProviderConfigBlob(
                        nextProviderConfigWithFieldValue(
                          props.config,
                          field,
                          option.value === fallback ? "" : option.value,
                        ),
                      ),
                    )
                  }
                />
              ))}
            </View>
          );
        }
        // A saved secret arrives redacted; keep the box empty and replace it only on input.
        const configured = field.secret && readProviderConfigString(props.config, field.key) !== "";
        return (
          <LabeledInput
            key={field.key}
            label={field.label}
            description={field.description}
            placeholder={
              configured ? "Saved. Enter a new value to replace." : (field.placeholder ?? "")
            }
            secure={field.secret === true || field.control === "password"}
            multiline={field.control === "textarea"}
            disabled={props.disabled}
            value={
              field.secret
                ? (secrets[field.key] ?? "")
                : readProviderConfigString(props.config, field.key)
            }
            onChangeText={(value) => {
              if (field.secret) {
                setSecrets((current) => ({ ...current, [field.key]: value }));
              }
              props.onChange(
                nextProviderDraftConfigWithFieldValue(
                  props.config,
                  props.initialConfig,
                  field,
                  value,
                ),
              );
            }}
          />
        );
      })}
    </>
  );
}

function LabeledInput(props: {
  readonly label: string;
  readonly description?: string | undefined;
  readonly placeholder: string;
  readonly value: string;
  readonly disabled: boolean;
  readonly secure?: boolean;
  readonly multiline?: boolean;
  readonly mono?: boolean;
  readonly onChangeText: (value: string) => void;
}) {
  return (
    <View className="gap-1 px-4 py-2">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <TextInput
        accessibilityLabel={props.label}
        className={FIELD_CLASS}
        placeholderTextColorClassName="accent-foreground-muted"
        placeholder={props.placeholder}
        secureTextEntry={props.secure}
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
        multiline={props.multiline}
        value={props.value}
        onChangeText={props.onChangeText}
      />
      {props.description ? (
        <Text className="text-xs text-foreground-muted">{props.description}</Text>
      ) : null}
    </View>
  );
}

/** Stable React keys for editable rows, so typing in a row never remounts its input. */
function useRowKeys(count: number) {
  const ids = useRef<string[]>([]);
  const next = useRef(0);
  while (ids.current.length < count) ids.current.push(`row-${next.current++}`);
  ids.current.length = count;
  return {
    keyAt: (index: number) => ids.current[index],
    removeAt: (index: number) => ids.current.splice(index, 1),
  };
}

function EnvironmentEditor(props: {
  readonly rows: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly dedicatedNames: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onChange: (rows: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const dedicated = props.rows.filter((row) => props.dedicatedNames.has(row.name));
  const generic = props.rows.filter((row) => !props.dedicatedNames.has(row.name));
  const keys = useRowKeys(generic.length);
  const publish = (next: ReadonlyArray<ProviderInstanceEnvironmentVariable>) =>
    props.onChange([...dedicated, ...next]);
  const update = (index: number, row: ProviderInstanceEnvironmentVariable) =>
    publish(generic.map((entry, i) => (i === index ? row : entry)));
  return (
    <View>
      <Text className="px-4 pt-3 text-sm font-paperplane-medium text-foreground">Variables</Text>
      <Text className="px-4 text-xs text-foreground-muted">
        API keys, base URLs and other per-instance settings. Sensitive values stay on the
        environment and are never shown again.
      </Text>
      {generic.map((row, index) => (
        <View key={keys.keyAt(index)} className="gap-1 px-4 py-2">
          <TextInput
            accessibilityLabel={`Variable name ${index + 1}`}
            className={FIELD_CLASS}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder="VARIABLE_NAME"
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
            value={row.name}
            onChangeText={(name) => update(index, { ...row, name })}
          />
          <TextInput
            accessibilityLabel={`Variable value ${index + 1}`}
            className={FIELD_CLASS}
            placeholderTextColorClassName="accent-foreground-muted"
            placeholder={row.valueRedacted ? "Saved. Enter a new value to replace." : "value"}
            secureTextEntry={row.sensitive}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
            value={row.valueRedacted ? "" : row.value}
            onChangeText={(value) => update(index, setEnvironmentRowValue(row, value))}
          />
          <SettingsSwitchRow
            label="Sensitive"
            value={row.sensitive}
            disabled={props.disabled}
            onValueChange={(sensitive) => update(index, setEnvironmentRowSensitive(row, sensitive))}
          />
          <SettingsActionRow
            icon="trash"
            label={`Remove variable ${row.name || index + 1}`}
            tone="danger"
            disabled={props.disabled}
            onPress={() => {
              keys.removeAt(index);
              publish(generic.filter((_, i) => i !== index));
            }}
          />
        </View>
      ))}
      <SettingsActionRow
        icon="plus"
        label="Add variable"
        disabled={props.disabled}
        onPress={() => publish([...generic, newEnvironmentRow()])}
      />
    </View>
  );
}

function CommandArguments(props: {
  readonly config: ProviderConfigBlob | undefined;
  readonly disabled: boolean;
  readonly onChange: (next: ProviderConfigBlob | undefined) => void;
}) {
  const args = readProviderCommandArgs(props.config);
  const keys = useRowKeys(args.length);
  const publish = (next: ReadonlyArray<string>) =>
    props.onChange(withProviderCommandArgs(props.config, next));
  return (
    <View>
      <Text className="px-4 pt-3 text-sm font-paperplane-medium text-foreground">Arguments</Text>
      <Text className="px-4 text-xs text-foreground-muted">
        One literal argument per row, in launch order.
      </Text>
      {args.map((argument, index) => (
        <View key={keys.keyAt(index)} className="gap-1 px-4 py-2">
          <TextInput
            accessibilityLabel={`Argument ${index + 1}`}
            className={FIELD_CLASS}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!props.disabled}
            value={argument}
            onChangeText={(value) => publish(args.map((entry, i) => (i === index ? value : entry)))}
          />
          <SettingsActionRow
            icon="trash"
            label={`Remove argument ${index + 1}`}
            tone="danger"
            disabled={props.disabled}
            onPress={() => {
              keys.removeAt(index);
              publish(args.filter((_, i) => i !== index));
            }}
          />
        </View>
      ))}
      <SettingsActionRow
        icon="plus"
        label="Add argument"
        disabled={props.disabled}
        onPress={() => publish([...args, ""])}
      />
    </View>
  );
}

/** Registry search and install for a new ACP instance, via the existing server flow. */
function AcpRegistryPicker(props: {
  readonly environmentId: SettingsTarget["environmentId"];
  readonly disabled: boolean;
  readonly onPrepared: (agent: AcpRegistrySearchAgent) => void;
}) {
  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [preparing, setPreparing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const search = useEnvironmentQuery(
    serverEnvironment.searchAcpRegistry({
      environmentId: props.environmentId,
      input: { query: submitted },
    }),
  );
  const prepare = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
    reportDefect: false,
  });
  async function choose(agent: AcpRegistrySearchAgent) {
    if (preparing !== null) return;
    setPreparing(agent.id);
    setError(null);
    try {
      const result = await prepare({
        environmentId: props.environmentId,
        input: { agentId: agent.id },
      });
      if (result._tag === "Success") {
        props.onPrepared({
          ...agent,
          id: result.value.agentId,
          version: result.value.version,
          distribution: result.value.distribution,
        });
      } else if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not install this agent.");
      }
    } catch {
      setError("Could not install this agent.");
    }
    setPreparing(null);
  }
  const busy = props.disabled || preparing !== null;
  return (
    <View>
      <LabeledInput
        label="Search ACP Registry"
        placeholder="Search agents"
        value={query}
        disabled={busy}
        onChangeText={setQuery}
      />
      <SettingsActionRow
        icon="magnifyingglass"
        label="Search"
        disabled={busy}
        loading={search.isPending}
        onPress={() => setSubmitted(query.trim())}
      />
      {search.error ? (
        <Text accessibilityRole="alert" className="px-4 text-danger-foreground">
          {search.error}
        </Text>
      ) : null}
      {(search.data?.agents ?? []).map((agent) => (
        <SettingsActionRow
          key={agent.id}
          icon="arrow.down.circle"
          label={`${agent.name} v${agent.version}`}
          description={agent.description || `Install ${agent.id} on this environment`}
          disabled={busy}
          loading={preparing === agent.id}
          onPress={() => void choose(agent)}
        />
      ))}
      {error ? (
        <Text accessibilityRole="alert" className="px-4 text-danger-foreground">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * The shared edit/create form: name, schema fields, ACP local command arguments,
 * and environment variables. Reports whether it holds unsaved edits.
 */
function InstanceForm(props: {
  readonly environmentId: SettingsTarget["environmentId"];
  readonly driver: ProviderInstanceConfig["driver"];
  readonly initial: ProviderInstanceDraft;
  readonly extraDirty?: boolean;
  readonly supportsPiWorkloadProtection: boolean;
  readonly extraError: string | null;
  readonly pending: boolean;
  readonly submitLabel: string;
  readonly header?: ReactNode;
  readonly footer?: ReactNode;
  readonly onSubmit: (draft: ProviderInstanceDraft) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onCancel: () => void;
}) {
  const definition = getProviderClient(props.driver);
  // A server refresh must not turn an untouched form dirty or overwrite in-progress edits.
  const [initial] = useState(props.initial);
  const [draft, setDraft] = useState(initial);
  const [attempted, setAttempted] = useState(false);
  const dirty = props.extraDirty === true || providerDraftChanged(initial, draft);
  const { onDirtyChange } = props;
  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);
  const fields = definition
    ? deriveProviderSettingsFields(definition, draft.config, props.supportsPiWorkloadProtection)
    : [];
  const isLocalAcp =
    props.driver === "acpRegistry" && readProviderConfigString(draft.config, "source") === "local";
  const environmentFields = definition?.environmentFields ?? [];
  const dedicatedNames = new Set(environmentFields.map((field) => field.name));
  const problem =
    validateProviderEnvironment(draft.environment) ??
    (definition ? validateProviderSettingsConfig(definition, draft.config) : null) ??
    (props.driver === "acpRegistry" ? validateAcpRegistryConfig(draft.config) : null);
  return (
    <View className="gap-1 py-2">
      {props.header}
      <LabeledInput
        label="Name"
        placeholder={definition?.label ?? String(props.driver)}
        value={draft.displayName}
        disabled={props.pending}
        onChangeText={(displayName) => setDraft({ ...draft, displayName })}
      />
      {props.driver === "codex" ? (
        <View>
          <Text className="px-4 pt-3 text-sm text-foreground-muted">Codex setup</Text>
          {(["managed", "existing"] as const).map((mode) => (
            <SettingsChoiceRow
              key={mode}
              label={
                mode === "managed" ? "Managed ChatGPT account" : "Use existing Codex installation"
              }
              description={
                mode === "managed"
                  ? "Sign in from Accounts after saving. Paperplane manages the CLI and credentials."
                  : "Use the environment's installed CLI and its existing credentials."
              }
              selected={
                (readProviderConfigString(draft.config, "setupMode") || "existing") === mode
              }
              disabled={props.pending}
              onPress={() => setDraft({ ...draft, config: { ...draft.config, setupMode: mode } })}
            />
          ))}
        </View>
      ) : null}
      <FieldInputs
        fields={fields}
        config={draft.config}
        initialConfig={initial.config}
        disabled={props.pending}
        onChange={(config) => setDraft({ ...draft, config })}
      />
      {isLocalAcp ? (
        <CommandArguments
          config={draft.config}
          disabled={props.pending}
          onChange={(config) => setDraft({ ...draft, config })}
        />
      ) : null}
      {environmentFields.map((field) => (
        <LabeledInput
          key={field.name}
          label={field.label}
          description={field.description}
          placeholder={
            readProviderEnvironmentVariable(draft.environment, field.name)?.valueRedacted
              ? "Saved. Enter a new value to replace."
              : (field.placeholder ?? "")
          }
          secure={field.sensitive !== false}
          disabled={props.pending}
          value={
            readProviderEnvironmentVariable(draft.environment, field.name)?.valueRedacted
              ? ""
              : (readProviderEnvironmentVariable(draft.environment, field.name)?.value ?? "")
          }
          onChangeText={(value) =>
            setDraft({
              ...draft,
              environment: nextProviderEnvironmentWithFieldValue(draft.environment, field, value),
            })
          }
        />
      ))}
      <EnvironmentEditor
        rows={draft.environment}
        dedicatedNames={dedicatedNames}
        disabled={props.pending}
        onChange={(environment) => setDraft({ ...draft, environment })}
      />
      {props.footer}
      {(attempted && problem) || props.extraError ? (
        <Text accessibilityRole="alert" className="px-4 text-danger-foreground">
          {props.extraError ?? problem}
        </Text>
      ) : null}
      <SettingsActionRow
        icon="checkmark"
        label={props.submitLabel}
        loading={props.pending}
        onPress={() => {
          setAttempted(true);
          if (problem) return;
          props.onSubmit(draft);
        }}
      />
      <SettingsActionRow
        icon="xmark"
        label="Cancel"
        onPress={() => {
          if (!dirty) {
            props.onCancel();
            return;
          }
          Dialog.alert("Discard changes?", "Your unsaved changes will be lost.", [
            { text: "Keep editing", style: "cancel" },
            { text: "Discard changes", style: "destructive", onPress: props.onCancel },
          ]);
        }}
      />
    </View>
  );
}

function InstanceEditor(props: {
  readonly environment: SettingsTarget;
  readonly row: ProviderInstanceRow;
  readonly supportsPiWorkloadProtection: boolean;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onDone: () => void;
}) {
  const { environment, row } = props;
  const mutation = useProviderInstanceMutation(environment.environmentId);
  const [initial] = useState(() => draftFromProviderInstance(row.instance));
  const uninstall = useAtomCommand(serverEnvironment.uninstallAcpRegistryManagedBinary, {
    reportFailure: false,
    reportDefect: false,
  });
  const remove = () =>
    Dialog.alert(
      row.isDefault ? "Reset provider?" : "Delete provider instance?",
      "This removes the instance settings. Managed agent files are removed only when no other instance uses them. Local commands are not deleted.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: row.isDefault ? "Reset" : "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              if (!(await mutation.run({ operation: "remove", instanceId: row.instanceId })))
                return;
              const agentId = readProviderConfigString(row.instance.config, "agentId");
              if (
                row.instance.driver === "acpRegistry" &&
                readProviderConfigString(row.instance.config, "source") !== "local" &&
                agentId
              ) {
                // The service checks the latest settings for shared installations, not this snapshot.
                const result = await uninstall({
                  environmentId: environment.environmentId,
                  input: { agentId },
                });
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  Dialog.alert(
                    "Provider deleted, but managed files remain",
                    String(squashAtomCommandFailure(result)),
                  );
                }
              }
              props.onDone();
            })();
          },
        },
      ],
    );
  return (
    <View className="border-t border-border-subtle">
      <InstanceForm
        environmentId={environment.environmentId}
        driver={row.instance.driver}
        initial={initial}
        supportsPiWorkloadProtection={props.supportsPiWorkloadProtection}
        extraError={mutation.error}
        pending={mutation.pending}
        submitLabel="Save"
        onDirtyChange={props.onDirtyChange}
        onCancel={props.onDone}
        onSubmit={(draft) =>
          void mutation
            .run(providerInstanceSaveMutation(row, draft))
            .then((ok) => ok && props.onDone())
        }
        footer={
          row.isDefault && !row.configured ? null : (
            <SettingsActionRow
              icon={row.isDefault ? "arrow.clockwise" : "trash"}
              label={row.isDefault ? "Reset to defaults" : "Delete instance"}
              tone="danger"
              disabled={mutation.pending}
              onPress={remove}
            />
          )
        }
      />
    </View>
  );
}

type AddStep =
  | { readonly kind: "driver" }
  | { readonly kind: "acp-source" }
  | {
      readonly kind: "form";
      readonly driver: ProviderInstanceConfig["driver"];
      readonly label: string;
      readonly config: ProviderConfigBlob | undefined;
      readonly acpName: string | null;
    };

function AddInstance(props: {
  readonly environment: SettingsTarget;
  readonly existingIds: ReadonlySet<string>;
  readonly supportsPiWorkloadProtection: boolean;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onDone: () => void;
}) {
  const { environmentId } = props.environment;
  const mutation = useProviderInstanceMutation(environmentId);
  const [step, setStep] = useState<AddStep>({ kind: "driver" });
  const [idOverride, setIdOverride] = useState<string | null>(null);
  const [idError, setIdError] = useState<string | null>(null);
  if (step.kind === "driver") {
    return (
      <View>
        {providerClientDefinitions.map((entry) => (
          <SettingsChoiceRow
            key={entry.driverKind}
            label={entry.label}
            selected={false}
            onPress={() =>
              entry.driverKind === "acpRegistry"
                ? setStep({ kind: "acp-source" })
                : setStep({
                    kind: "form",
                    driver: entry.driverKind,
                    label: entry.label,
                    config: entry.driverKind === "codex" ? { setupMode: "managed" } : undefined,
                    acpName: null,
                  })
            }
          />
        ))}
        <SettingsActionRow icon="xmark" label="Cancel" onPress={props.onDone} />
      </View>
    );
  }
  if (step.kind === "acp-source") {
    const acp = providerClientDefinitions.find((entry) => entry.driverKind === "acpRegistry");
    return (
      <View>
        <Text className="px-4 pt-3 text-xs text-foreground-muted">
          Registry agents are installed on the environment before they are added. Sign in from the
          Accounts section once the agent is added.
        </Text>
        <AcpRegistryPicker
          environmentId={environmentId}
          disabled={false}
          onPrepared={(agent) =>
            acp &&
            setStep({
              kind: "form",
              driver: acp.driverKind,
              label: agent.name,
              config: { agentId: agent.id, distribution: "auto" },
              acpName: agent.name,
            })
          }
        />
        {acp ? (
          <SettingsActionRow
            icon="terminal"
            label="Local ACP command"
            onPress={() =>
              setStep({
                kind: "form",
                driver: acp.driverKind,
                label: "Local ACP",
                config: { source: "local", commandArgs: [] },
                acpName: null,
              })
            }
          />
        ) : null}
        <SettingsActionRow icon="xmark" label="Cancel" onPress={props.onDone} />
      </View>
    );
  }
  const initial: ProviderInstanceDraft = {
    displayName: step.acpName ?? "",
    config: step.config,
    environment: [],
  };
  return (
    <InstanceForm
      environmentId={environmentId}
      driver={step.driver}
      initial={initial}
      extraDirty={idOverride !== null}
      supportsPiWorkloadProtection={props.supportsPiWorkloadProtection}
      extraError={mutation.error ?? idError}
      pending={mutation.pending}
      submitLabel="Add provider"
      header={
        <LabeledInput
          label="Instance ID"
          placeholder={deriveProviderInstanceId(step.driver, step.label)}
          value={idOverride ?? ""}
          disabled={mutation.pending}
          onChangeText={(value) => setIdOverride(value === "" ? null : value)}
        />
      }
      onDirtyChange={props.onDirtyChange}
      onCancel={props.onDone}
      onSubmit={(draft) => {
        const base = draft.displayName.trim() || step.label;
        const instanceId = idOverride ?? deriveProviderInstanceId(step.driver, base);
        const error = validateProviderInstanceId(instanceId, props.existingIds);
        setIdError(error);
        if (error) return;
        void mutation
          .run(providerInstanceCreateMutation({ driver: step.driver, instanceId, draft }))
          .then((ok) => ok && props.onDone());
      }}
    />
  );
}

/** Provider-instance administration for one environment. Writes need `providers:manage`. */
export function ProviderInstanceAdmin(props: {
  readonly environment: SettingsTarget;
  readonly onDirtyChange: (environmentId: SettingsTarget["environmentId"], dirty: boolean) => void;
}) {
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
  const { onDirtyChange: reportDirty } = props;
  const onDirtyChange = useCallback(
    (dirty: boolean) => reportDirty(environmentId, dirty),
    [reportDirty, environmentId],
  );
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
              onDirtyChange={onDirtyChange}
              onDone={() => setEditing(null)}
            />
          ) : canManage && editing === null && !adding ? (
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
          onDirtyChange={onDirtyChange}
          onDone={() => setAdding(false)}
        />
      ) : canManage && editing === null ? (
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
