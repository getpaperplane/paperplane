import { useMemo } from "react";
import {
  PI_THINKING_LEVELS,
  type PiThinkingLevel,
  type ServerProvider,
  type ServerProviderModel,
} from "@rove-code/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ComposerSelectControl } from "../chat/ComposerControl";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { SettingsRow, SETTINGS_PICKER_TRIGGER_CLASSNAME } from "./settingsLayout";
import type { ProviderSettingsFieldModel } from "./ProviderSettingsForm";
const EMPTY_MODELS: ReadonlyArray<ServerProviderModel> = [];
const THINKING_LABELS = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
} satisfies Record<PiThinkingLevel, string>;

const decodeSettings = Schema.decodeUnknownOption(
  Schema.Struct({
    subagentModel: Schema.optionalKey(Schema.String),
    subagentThinkingLevel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

function thinkingLevelLabel(level: string) {
  const known = PI_THINKING_LEVELS.find((candidate) => candidate === level);
  return known ? THINKING_LABELS[known] : level;
}

export function resolvePiSubagentSettings(
  value: unknown,
  models: ReadonlyArray<ServerProviderModel>,
) {
  const settings = Option.getOrUndefined(decodeSettings(value));
  const model = settings?.subagentModel?.trim() ?? "";
  const thinking = settings?.subagentThinkingLevel?.trim() ?? "";
  const selectedModel = models.find((candidate) => candidate.slug === model);
  const descriptor = selectedModel?.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === "thinkingLevel" && candidate.type === "select",
  );
  // The caller's model is not known in provider settings. Let Pi clamp the
  // override at delegation time when the child inherits that model.
  const thinkingOptions = !model
    ? PI_THINKING_LEVELS.map((id) => ({ id, label: THINKING_LABELS[id] }))
    : descriptor?.type === "select"
      ? descriptor.options
      : [];
  const modelOptions = [
    ...models,
    ...(model && !selectedModel
      ? [{ slug: model, name: model, isCustom: false, isUnavailable: true }]
      : []),
  ];
  return {
    model,
    thinking,
    modelOptions,
    thinkingOptions,
    thinkingUnavailable:
      thinking !== "" && !thinkingOptions.some((option) => option.id === thinking),
  };
}

/** Reuses the composer's catalog picker, scoped to this exact Pi instance. */
export function PiSubagentSettings({
  modelField,
  thinkingField,
  value,
  provider,
  models = EMPTY_MODELS,
  idPrefix,
  variant,
  onModelChange,
  onThinkingChange,
}: {
  modelField: ProviderSettingsFieldModel;
  thinkingField: ProviderSettingsFieldModel;
  value: unknown;
  provider?: ServerProvider | undefined;
  models?: ReadonlyArray<ServerProviderModel> | undefined;
  idPrefix: string;
  variant: "card" | "dialog" | "settings";
  onModelChange: (model: string) => void;
  onThinkingChange: (thinking: string) => void;
}) {
  const { model, thinking, modelOptions, thinkingOptions, thinkingUnavailable } = useMemo(
    () => resolvePiSubagentSettings(value, models),
    [value, models],
  );
  const entries = useMemo(
    () => deriveProviderInstanceEntries(provider ? [provider] : []),
    [provider],
  );
  const optionsByInstance = useMemo(
    () => new Map(entries.map((entry) => [entry.instanceId, modelOptions])),
    [entries, modelOptions],
  );
  const modelId = `${idPrefix}-${modelField.key}`;
  const thinkingId = `${idPrefix}-${thinkingField.key}`;
  const thinkingLabel = !thinking
    ? "Use thread thinking"
    : thinkingUnavailable
      ? `${thinkingLevelLabel(thinking)} (unavailable)`
      : (thinkingOptions.find((option) => option.id === thinking)?.label ?? thinking);
  const description = thinkingUnavailable
    ? "The saved thinking override is not supported by this model. Choose a supported level or use thread thinking."
    : !provider
      ? "Use the thread's model and thinking, or connect this provider to choose a different model."
      : "Model and thinking for subagents. Unset choices follow the thread. Changes apply to new Pi sessions.";
  const controls = (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
      {provider ? (
        <ProviderModelPicker
          activeInstanceId={provider.instanceId}
          model={model}
          lockedProvider={provider.driver}
          {...(!model ? { triggerLabel: "Use thread model" } : {})}
          defaultOption={{ label: "Use thread model", onSelect: () => onModelChange("") }}
          instanceEntries={entries}
          modelOptionsByInstance={optionsByInstance}
          triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
          triggerAriaLabel={modelField.label}
          getModelDisabledReason={(_instanceId, slug) =>
            !models.some((candidate) => candidate.slug === slug)
              ? "This model is no longer in this provider's catalog."
              : null
          }
          onInstanceModelChange={(_instanceId, next) => onModelChange(next)}
        />
      ) : (
        <Select value={model} onValueChange={(next) => next !== null && onModelChange(next)}>
          <ComposerSelectControl id={modelId} aria-label={modelField.label}>
            <SelectValue>{model || "Use thread model"}</SelectValue>
          </ComposerSelectControl>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="">Use thread model</SelectItem>
            {model ? (
              <SelectItem value={model} disabled>
                {model} (unavailable)
              </SelectItem>
            ) : null}
          </SelectPopup>
        </Select>
      )}
      <Select
        value={thinking}
        onValueChange={(next) => {
          if (
            next !== null &&
            (next === "" || thinkingOptions.some((option) => option.id === next))
          ) {
            onThinkingChange(next);
          }
        }}
      >
        <ComposerSelectControl id={thinkingId} aria-label={thinkingField.label}>
          <SelectValue>{thinkingLabel}</SelectValue>
        </ComposerSelectControl>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem value="">Use thread thinking</SelectItem>
          {thinkingUnavailable ? (
            <SelectItem value={thinking} disabled>
              {thinkingLabel}
            </SelectItem>
          ) : null}
          {thinkingOptions.map((option) => (
            <SelectItem key={option.id} value={option.id}>
              {option.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
  return variant === "settings" ? (
    <SettingsRow title={modelField.label} description={description} control={controls} />
  ) : (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-foreground">{modelField.label} and thinking</span>
      {controls}
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}
