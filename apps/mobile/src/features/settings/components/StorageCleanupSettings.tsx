import { useAtomValue } from "@effect/atom-react";
import type {
  ServerSettingsPatch,
  StorageCleanupReport,
  WorktreeKeepWhen,
  WorktreeCleanupRules,
} from "@getpaperplane/contracts";
import {
  describeStorageCleanupCounts,
  hasEnabledCleanupRules,
  parseRetentionDays,
  planWorktreesDirectoryChange,
  storageCleanupEntryName,
  uniformValue,
} from "@getpaperplane/client-runtime/environment-admin";
import { resolveWorktreeCleanup } from "@getpaperplane/shared/projectSettings";
import type { ScopedMobileSettingsTarget } from "../settings-scoped-server";
import { squashAtomCommandFailure } from "@getpaperplane/client-runtime/state/runtime";
import { Atom, AsyncResult } from "effect/reactivity";
import { useMemo, useRef, useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import type { SettingsTarget } from "../settings-environment-filter";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsChoiceRow } from "./SettingsChoiceRow";
import { SettingsSection } from "./SettingsSection";
import { SettingsSwitchRow } from "./SettingsSwitchRow";

const KEEP_WHEN: ReadonlyArray<{
  readonly value: WorktreeKeepWhen;
  readonly label: string;
  readonly description: string;
}> = [
  {
    value: "any-local-files",
    label: "Any local files",
    description: "Includes ignored files, except node_modules.",
  },
  {
    value: "uncommitted-changes",
    label: "Uncommitted changes",
    description: "Keeps edits and untracked files. Deletes ignored files, including .env.",
  },
  {
    value: "tracked-changes",
    label: "Edited tracked files",
    description: "Deletes untracked and ignored files, including .env.",
  },
];

type RetentionKey = "worktreeAfterDays" | "browserArtifactsAfterDays" | "logsAfterDays";

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length);
  return `${(bytes / 1024 ** exponent).toFixed(1)} ${units[exponent - 1]}`;
}

/** Retention in days: a switch plus a day count; a mixed selection offers "Set on". */
function RetentionRow(props: {
  readonly label: string;
  readonly subtitle: string;
  readonly values: readonly (number | null)[];
  readonly minimum?: number;
  readonly disabled: boolean;
  readonly onChange: (days: number | null) => void;
}) {
  const value = uniformValue(props.values);
  const edited = useRef(false);
  return (
    <>
      <SettingsSwitchRow
        label={props.label}
        subtitle={props.subtitle}
        value={value === undefined ? null : value !== null}
        disabled={props.disabled}
        onValueChange={(enabled) => props.onChange(enabled ? 8 : null)}
      />
      {value !== undefined && value !== null ? (
        <View className="flex-row items-center gap-2 border-t border-border-subtle px-4 py-2">
          <AppTextInput
            key={value}
            accessibilityLabel={`${props.label} in days`}
            keyboardType="number-pad"
            defaultValue={String(value)}
            editable={!props.disabled}
            className="min-h-10 w-20 rounded-xl px-3 py-2 text-base text-foreground"
            onChangeText={() => {
              edited.current = true;
            }}
            onEndEditing={(event) => {
              const days = parseRetentionDays(event.nativeEvent.text, props.minimum);
              if (edited.current && days !== null && days !== value) props.onChange(days);
              edited.current = false;
            }}
          />
          <Text className="text-sm text-foreground-muted">days</Text>
        </View>
      ) : null}
    </>
  );
}

/**
 * Storage cleanup policy and run for the selected environments, plus where
 * new worktrees go. Mirrors web Settings > Storage; the server validates
 * every value and decides what a run may remove.
 */
export function StorageCleanupSettings(props: {
  readonly targets: readonly SettingsTarget[];
  readonly disabled: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
}) {
  const { targets, disabled, write } = props;
  const directoryEdited = useRef(false);
  const supported = targets.filter(
    (target) => target.serverConfig.environment.capabilities.storageCleanup === true,
  );
  const canRun = supported.filter(
    (target) => target.serverConfig.environment.capabilities.storageCleanupRun === true,
  );
  const withDirectory = targets.every(
    (target) => target.serverConfig.environment.capabilities.worktreesDirectory === true,
  );
  if (targets.length === 0) return null;
  const allSupported = supported.length === targets.length;
  const allCanRun = canRun.length === targets.length;
  const settings = targets.map((target) => target.serverConfig.settings);
  const storage = <K extends keyof (typeof settings)[number]["storageCleanup"]>(key: K) =>
    settings.map((entry) => entry.storageCleanup[key]);
  const patch = (value: Partial<(typeof settings)[number]["storageCleanup"]>) =>
    write({ storageCleanup: value });
  const keepWhen = uniformValue(storage("worktreeKeepWhen"));
  const directories = settings.map((entry) => entry.worktreesDirectory);
  const directory = uniformValue(directories);

  return (
    <>
      {withDirectory ? (
        <SettingsSection
          title="Worktree location"
          footer="Folder where new worktrees are created, such as ~/worktrees. Existing worktrees stay where they are. Leave empty to use the Paperplane home folder. The environment checks the path."
        >
          <View className="gap-2 px-4 py-3">
            <AppTextInput
              key={directory ?? "mixed"}
              accessibilityLabel="Worktree location"
              defaultValue={directory ?? ""}
              placeholder={directory === undefined ? "Mixed" : "Default"}
              editable={!disabled}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-10 rounded-xl px-3 py-2 text-base text-foreground"
              onChangeText={() => {
                directoryEdited.current = true;
              }}
              onEndEditing={(event) => {
                const next = planWorktreesDirectoryChange(directories, event.nativeEvent.text);
                if (!disabled && directoryEdited.current && next !== undefined)
                  write({ worktreesDirectory: next });
                directoryEdited.current = false;
              }}
            />
          </View>
          {directory !== "" ? (
            <SettingsActionRow
              icon="arrow.clockwise"
              label="Reset to default location"
              disabled={disabled}
              onPress={() => write({ worktreesDirectory: "" })}
            />
          ) : null}
        </SettingsSection>
      ) : null}
      {!allSupported ? (
        <Text className="px-2 text-sm text-foreground-muted">
          Update the selected environments to use storage cleanup.
        </Text>
      ) : (
        <>
          <SettingsSection title="Automatic cleanup">
            <SettingsSwitchRow
              label="Delete worktrees with deleted threads"
              subtitle="Remove unused worktrees when threads are deleted. Worktrees with local changes are kept."
              value={uniformValue(storage("worktreeOnDelete")) ?? null}
              disabled={disabled}
              onValueChange={(worktreeOnDelete) => patch({ worktreeOnDelete })}
            />
            <RetentionRow
              label="Delete inactive worktrees"
              subtitle="Remove worktrees after their threads have been inactive for this many days. Branches and history are kept."
              values={storage("worktreeAfterDays")}
              disabled={disabled}
              onChange={(worktreeAfterDays) => patch({ worktreeAfterDays })}
            />
            {targets.every(
              (target) =>
                target.serverConfig.environment.capabilities.settledWorktreeCleanup === true,
            ) ? (
              <RetentionRow
                label="Delete settled worktrees"
                subtitle="Remove worktrees this many days after their thread settles."
                values={storage("worktreeSettledAfterDays")}
                minimum={0}
                disabled={disabled}
                onChange={(worktreeSettledAfterDays) => patch({ worktreeSettledAfterDays })}
              />
            ) : null}
            <SettingsSwitchRow
              label="Delete merged worktrees"
              subtitle="Remove worktrees whose pull request is merged into the default branch."
              value={uniformValue(storage("worktreeOnMerge")) ?? null}
              disabled={disabled}
              onValueChange={(worktreeOnMerge) => patch({ worktreeOnMerge })}
            />
            <SettingsSwitchRow
              label="Delete unchanged worktrees"
              subtitle="Remove worktrees with no commits beyond the default branch."
              value={uniformValue(storage("worktreeUnchanged")) ?? null}
              disabled={disabled}
              onValueChange={(worktreeUnchanged) => patch({ worktreeUnchanged })}
            />
            <RetentionRow
              label="Delete old browser artifacts"
              subtitle="Older capture links will no longer open."
              values={storage("browserArtifactsAfterDays")}
              disabled={disabled}
              onChange={(browserArtifactsAfterDays) => patch({ browserArtifactsAfterDays })}
            />
            <RetentionRow
              label="Delete old rotated logs"
              subtitle="Current logs are kept."
              values={storage("logsAfterDays") as (number | null)[]}
              disabled={disabled}
              onChange={(logsAfterDays) => patch({ logsAfterDays })}
            />
          </SettingsSection>
          {allCanRun ? (
            <SettingsSection
              title="Keep worktrees with"
              trailing={
                keepWhen === undefined ? (
                  <Text className="px-2 text-sm text-foreground-muted">Mixed</Text>
                ) : null
              }
            >
              {KEEP_WHEN.map((choice, index) => (
                <SettingsChoiceRow
                  key={choice.value}
                  label={choice.label}
                  description={choice.description}
                  selected={keepWhen === choice.value}
                  separated={index > 0}
                  disabled={disabled}
                  onPress={() => patch({ worktreeKeepWhen: choice.value })}
                />
              ))}
            </SettingsSection>
          ) : null}
          {canRun.length > 0 ? <CleanupRun targets={canRun} /> : null}
        </>
      )}
    </>
  );
}

/** Only worktree rules are project-scoped; storage retention and manual runs are not. */
export function ProjectWorktreeCleanupSettings(props: {
  readonly targets: readonly ScopedMobileSettingsTarget[];
  readonly disabled: boolean;
  readonly write: (patch: ServerSettingsPatch) => void;
  readonly inherit: () => void;
}) {
  const { targets, disabled, write } = props;
  const supported =
    targets.length > 0 &&
    targets.every(
      (target) =>
        target.environment.serverConfig.environment.capabilities.projectWorktreeCleanup === true &&
        target.environment.serverConfig.environment.capabilities.storageCleanup === true,
    );
  if (!supported)
    return (
      <Text className="px-2 text-sm text-foreground-muted">
        Update the selected environments to configure project worktree cleanup.
      </Text>
    );
  const modes = targets.map((target) =>
    target.sources.worktreeCleanup === "project"
      ? (target.settings.worktreeCleanup?.mode ?? "inherit")
      : "inherit",
  );
  const mode = uniformValue(modes);
  const rules = targets.map((target) =>
    resolveWorktreeCleanup(target.environment.serverConfig.settings, target.projectId),
  );
  const values = <K extends keyof WorktreeCleanupRules>(key: K) => rules.map((entry) => entry[key]);
  const patch = (rules: Partial<WorktreeCleanupRules>) =>
    write({ worktreeCleanup: { mode: "custom", rules } });
  return (
    <SettingsSection title="Automatic worktree cleanup">
      {(["inherit", "off", "custom"] as const).map((choice) => (
        <SettingsChoiceRow
          key={choice}
          label={
            choice === "inherit"
              ? "Use environment defaults"
              : choice === "off"
                ? "Off"
                : "Custom project rules"
          }
          description={
            choice === "off"
              ? "Keep this project's worktrees until you delete them manually."
              : undefined
          }
          selected={mode === choice}
          disabled={disabled}
          onPress={() =>
            choice === "inherit"
              ? props.inherit()
              : write({
                  worktreeCleanup:
                    choice === "off" ? { mode: "off" } : { mode: "custom", rules: {} },
                })
          }
        />
      ))}
      {mode === "custom" ? (
        <>
          <SettingsSwitchRow
            label="Delete worktrees with deleted threads"
            value={uniformValue(values("worktreeOnDelete")) ?? null}
            disabled={disabled}
            onValueChange={(worktreeOnDelete) => patch({ worktreeOnDelete })}
          />
          <RetentionRow
            label="Delete inactive worktrees"
            subtitle="Remove worktrees after their threads have been inactive for this many days."
            values={values("worktreeAfterDays")}
            disabled={disabled}
            onChange={(worktreeAfterDays) => patch({ worktreeAfterDays })}
          />
          {targets.every(
            (target) =>
              target.environment.serverConfig.environment.capabilities.settledWorktreeCleanup ===
              true,
          ) ? (
            <RetentionRow
              label="Delete settled worktrees"
              subtitle="Remove worktrees this many days after their thread settles."
              values={values("worktreeSettledAfterDays")}
              minimum={0}
              disabled={disabled}
              onChange={(worktreeSettledAfterDays) => patch({ worktreeSettledAfterDays })}
            />
          ) : null}
          <SettingsSwitchRow
            label="Delete merged worktrees"
            value={uniformValue(values("worktreeOnMerge")) ?? null}
            disabled={disabled}
            onValueChange={(worktreeOnMerge) => patch({ worktreeOnMerge })}
          />
          <SettingsSwitchRow
            label="Delete unchanged worktrees"
            value={uniformValue(values("worktreeUnchanged")) ?? null}
            disabled={disabled}
            onValueChange={(worktreeUnchanged) => patch({ worktreeUnchanged })}
          />
          <Text className="px-4 pt-3 text-sm text-foreground-muted">Keep worktrees with</Text>
          {KEEP_WHEN.map((choice) => (
            <SettingsChoiceRow
              key={choice.value}
              label={choice.label}
              description={choice.description}
              selected={uniformValue(values("worktreeKeepWhen")) === choice.value}
              disabled={disabled}
              onPress={() => patch({ worktreeKeepWhen: choice.value })}
            />
          ))}
        </>
      ) : null}
    </SettingsSection>
  );
}

/** Last results per environment, then Delete now using the saved rules. */
function CleanupRun(props: { readonly targets: readonly SettingsTarget[] }) {
  const { targets } = props;
  const run = useAtomCommand(serverEnvironment.runStorageCleanup, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const state = useAtomValue(
    useMemo(
      () =>
        Atom.make((get) =>
          targets.map((target) => {
            const query = get(
              serverEnvironment.storageCleanupReport({
                environmentId: target.environmentId,
                input: {},
              }),
            );
            return {
              target,
              allowed: get(
                serverEnvironment.runStorageCleanup.permissionAtom(target.environmentId),
              ),
              report:
                query._tag === "Success" ? (query.value as StorageCleanupReport | null) : null,
              loading: query.waiting,
              failed: query._tag === "Failure",
            };
          }),
        ),
      [targets],
    ),
  );
  const hasRules = targets.some((target) => hasEnabledCleanupRules(target.serverConfig.settings));
  const runnable = state.filter((entry) => entry.allowed);
  const deleteNow = async () => {
    if (pending || runnable.length === 0) return;
    setPending(true);
    setErrors([]);
    try {
      const messages = await Promise.all(
        runnable.map(async ({ target }) => {
          const result = await run({ environmentId: target.environmentId, input: {} });
          if (AsyncResult.isSuccess(result)) {
            const failure = result.value.entries.find((entry) => entry.outcome === "failed");
            return failure ? `Cleanup failed on ${target.label}: ${failure.reason}` : null;
          }
          return `Could not run cleanup on ${target.label}: ${String(squashAtomCommandFailure(result))}`;
        }),
      );
      setErrors(messages.filter((message): message is string => message !== null));
    } finally {
      setPending(false);
    }
  };
  return (
    <SettingsSection
      title="Cleanup"
      footer={hasRules ? undefined : "Turn on a cleanup rule to use this."}
    >
      {state.map(({ target, report, loading, failed }) => (
        <View key={target.environmentId} className="gap-1 px-4 py-3">
          <Text className="text-base text-foreground">{target.label}</Text>
          <Text className="text-sm text-foreground-muted">
            {report
              ? `Last run ${new Date(report.finishedAt).toLocaleString()}. ${formatBytes(report.bytesFreed)} recovered. ${describeStorageCleanupCounts(report.counts)}.`
              : failed
                ? "Could not load the last run."
                : loading
                  ? "Loading last run…"
                  : "Cleanup hasn't run yet."}
          </Text>
          {report?.entries.slice(0, 10).map((entry, index) => (
            <Text
              key={`${entry.path ?? entry.kind}:${entry.threadId ?? index}`}
              className={`text-xs ${entry.outcome === "failed" ? "text-danger-foreground" : "text-foreground-muted"}`}
            >
              {storageCleanupEntryName(entry)}: {entry.outcome}. {entry.reason}
            </Text>
          ))}
          {report && report.entries.length + report.omittedCount > 10 ? (
            <Text className="text-xs text-foreground-muted">
              {report.entries.length + report.omittedCount - 10} more results.
            </Text>
          ) : null}
        </View>
      ))}
      {errors.map((message) => (
        <Text
          key={message}
          accessibilityRole="alert"
          className="px-4 py-2 text-sm text-danger-foreground"
        >
          {message}
        </Text>
      ))}
      <SettingsActionRow
        icon="trash"
        tone="danger"
        label="Delete now"
        description="Runs the saved rules immediately."
        loading={pending}
        disabled={!hasRules || runnable.length === 0}
        onPress={() => void deleteNow()}
      />
    </SettingsSection>
  );
}
