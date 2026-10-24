import { useAtomValue } from "@effect/atom-react";
import type { OtlpSignal } from "@getpaperplane/contracts";
import {
  describeOtlpEndpointStatus,
  isOtlpHttpUrl,
  isOtlpEndpointInputValid,
  type OtlpEndpointCheck,
} from "@getpaperplane/client-runtime/environment-admin";
import { squashAtomCommandFailure } from "@getpaperplane/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";

const SIGNALS = [
  { key: "otlpTracesUrl", label: "Traces", signal: "traces" },
  { key: "otlpMetricsUrl", label: "Metrics", signal: "metrics" },
  { key: "otlpLogsUrl", label: "Logs", signal: "logs" },
] as const;
type SignalKey = (typeof SIGNALS)[number]["key"];

/** OTLP export endpoints for one environment, with a server-side reachability test. */
export function OtlpEndpointSettings(props: { readonly target: SettingsTarget }) {
  // Mount per environment so drafts and checks never cross machines.
  return <OtlpEndpointForm key={props.target.environmentId} target={props.target} />;
}

function OtlpEndpointForm({ target }: { readonly target: SettingsTarget }) {
  const { environmentId } = target;
  const saved = target.serverConfig.settings.observability;
  const running = target.serverConfig.observability;
  const [draft, setDraft] = useState<Partial<typeof saved>>({});
  const [checks, setChecks] = useState<Partial<Record<SignalKey, OtlpEndpointCheck>>>({});
  const [failure, setFailure] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // Checks need the same grant as saving, so one permission covers the form.
  const canEdit = useAtomValue(serverEnvironment.checkOtlpEndpoint.permissionAtom(environmentId));
  const canCheck =
    canEdit && target.serverConfig.environment.capabilities.otlpEndpointCheck === true;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    reportFailure: false,
  });
  const checkEndpoint = useAtomCommand(serverEnvironment.checkOtlpEndpoint, {
    reportFailure: false,
  });
  const values = { ...saved, ...draft };
  const changed = SIGNALS.filter(({ key }) => values[key].trim() !== saved[key]);

  const test = async (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!canCheck || !isOtlpHttpUrl(url)) return;
    setFailure(null);
    setChecks((previous) => ({ ...previous, [key]: { url, result: null } }));
    const response = await checkEndpoint({ environmentId, input: { signal, url } });
    setChecks((previous) => {
      if (previous[key]?.url !== url || previous[key].result !== null) return previous;
      const next = { ...previous };
      if (AsyncResult.isSuccess(response)) next[key] = { url, result: response.value };
      else delete next[key];
      return next;
    });
    if (!AsyncResult.isSuccess(response))
      setFailure(`Could not test ${signal}: ${String(squashAtomCommandFailure(response))}`);
  };

  const valid = changed.every(({ key }) => isOtlpEndpointInputValid(values[key]));
  const save = async () => {
    if (saving || !canEdit || changed.length === 0 || !valid) return;
    setSaving(true);
    setMessage(null);
    setFailure(null);
    try {
      const result = await updateSettings({
        environmentId,
        input: {
          patch: {
            observability: Object.fromEntries(changed.map(({ key }) => [key, values[key].trim()])),
          },
        },
      });
      if (AsyncResult.isSuccess(result)) {
        setDraft({});
        setMessage("Saved. Restart the server to apply.");
      } else {
        setFailure(`Could not save: ${String(squashAtomCommandFailure(result))}`);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection
      title={`OpenTelemetry export on ${target.label}`}
      footer="Send traces, metrics, and logs to an OTLP HTTP receiver. Restart the server to apply. Environment variables override these settings. Leave empty to disable."
    >
      {!canEdit ? (
        <Text className="px-4 py-3 text-sm text-foreground-muted">
          This connection lacks permission to change settings on {target.label}.
        </Text>
      ) : null}
      {SIGNALS.map(({ key, label, signal }) => {
        const url = values[key].trim();
        const status = canCheck ? describeOtlpEndpointStatus(url, checks[key]) : null;
        return (
          <View key={key} className="gap-1 border-b border-border-subtle px-4 py-3">
            <View className="flex-row items-center justify-between gap-3">
              <Text className="text-base text-foreground">{label} endpoint</Text>
              {status ? (
                <Text
                  className={`text-sm ${status.tone === "failure" ? "text-danger-foreground" : "text-foreground-muted"}`}
                >
                  {status.label}
                </Text>
              ) : null}
            </View>
            <AppTextInput
              accessibilityLabel={`${label} endpoint`}
              value={values[key]}
              editable={canEdit && !saving}
              keyboardType="url"
              autoCapitalize="none"
              autoCorrect={false}
              placeholder={`http://localhost:4318/v1/${signal}`}
              className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
              onChangeText={(value) => {
                setMessage(null);
                // Restoring the saved value drops the draft so a later save
                // cannot resend it over another client's change.
                setDraft((previous) => {
                  const next = { ...previous, [key]: value };
                  if (value.trim() === saved[key]) delete next[key];
                  return next;
                });
              }}
            />
            {url !== "" && !isOtlpHttpUrl(url) ? (
              <Text className="text-xs text-danger-foreground">
                Enter an HTTP or HTTPS endpoint.
              </Text>
            ) : null}
            {saved[key] !== (running?.[key] ?? "") ? (
              <Text className="text-xs text-foreground-muted">
                Running: {running?.[key] || "Disabled"}
              </Text>
            ) : null}
            {canCheck ? (
              <SettingsActionRow
                icon="arrow.clockwise"
                label={`Test ${label.toLowerCase()} endpoint`}
                disabled={!isOtlpHttpUrl(url) || checks[key]?.result === null}
                loading={checks[key]?.result === null && checks[key]?.url === url}
                onPress={() => void test(key, signal, url)}
              />
            ) : null}
          </View>
        );
      })}
      {failure ? (
        <Text accessibilityRole="alert" className="px-4 py-2 text-sm text-danger-foreground">
          {failure}
        </Text>
      ) : null}
      {message ? <Text className="px-4 py-2 text-sm text-foreground-muted">{message}</Text> : null}
      <SettingsActionRow
        icon="arrow.uturn.backward"
        label="Discard changes"
        disabled={changed.length === 0 || saving || !canEdit || !valid}
        onPress={() => {
          setDraft({});
          setMessage(null);
          setFailure(null);
        }}
      />
      <SettingsActionRow
        icon="checkmark"
        label="Save endpoints"
        disabled={changed.length === 0 || !canEdit}
        loading={saving}
        onPress={() => void save()}
      />
    </SettingsSection>
  );
}
