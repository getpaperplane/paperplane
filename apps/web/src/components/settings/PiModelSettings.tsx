import { useMemo } from "react";
import {
  PI_THINKING_LEVELS,
  type EnvironmentId,
  type PiThinkingLevel,
  type ServerProvider,
  type ServerProviderModel,
} from "@rove-code/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ComposerSelectControl } from "../chat/ComposerControl";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
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
    model: Schema.optionalKey(Schema.String),
    thinkingLevel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  }),
);

function thinkingLevelLabel(level: string) {
  const known = PI_THINKING_LEVELS.find((candidate) => candidate === level);
  return known ? THINKING_LABELS[known] : level;
}

function thinkingDescriptorOptions(model: ServerProviderModel | undefined) {
  const descriptor = model?.capabilities?.optionDescriptors?.find(
    (candidate) => candidate.id === "thinkingLevel" && candidate.type === "select",
  );
  return descriptor?.type === "select" ? descriptor.options : [];
}

export function resolvePiModelSettings(value: unknown, models: ReadonlyArray<ServerProviderModel>) {
  const settings = Option.getOrUndefined(decodeSettings(value));
  const model = settings?.model?.trim() ?? "";
  const thinking = settings?.thinkingLevel?.trim() ?? "";
  const selectedModel = models.find((candidate) => candidate.slug === model);
  const thinkingOptions = thinkingDescriptorOptions(
    model ? selectedModel : models.find((candidate) => candidate.isDefault),
  );
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

function describe({
  hasProvider,
  hasThinkingOptions,
  thinkingUnavailable,
}: {
  hasProvider: boolean;
  hasThinkingOptions: boolean;
  thinkingUnavailable: boolean;
}) {
  if (thinkingUnavailable) {
    return `The saved thinking override is not supported by this model. Choose a supported level or use Pi default thinking.`;
  }
  if (!hasProvider) {
    return "Model for new threads, as provider/model-id from your Pi catalog. Unset choices use your Pi default.";
  }
  return hasThinkingOptions
    ? "Model and thinking for new threads. Unset choices use your Pi default."
    : "Thinking choices appear once the selected model is in this provider's catalog.";
}

/**
 * One settings row for a Pi model + thinking pair. Reuses the composer's
 * catalog picker, scoped to this exact Pi instance.
 */
export function PiModelSettings({
  environmentId,
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
  environmentId: EnvironmentId | null;
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
    () => resolvePiModelSettings(value, models),
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
  const inheritModelLabel = "Use Pi default model";
  const inheritThinkingLabel = "Use Pi default thinking";
  const modelId = `${idPrefix}-${modelField.key}`;
  const thinkingId = `${idPrefix}-${thinkingField.key}`;
  const thinkingLabel = !thinking
    ? inheritThinkingLabel
    : thinkingUnavailable
      ? `${thinkingLevelLabel(thinking)} (unavailable)`
      : (thinkingOptions.find((option) => option.id === thinking)?.label ?? thinking);
  const description = describe({
    hasProvider: provider !== undefined,
    hasThinkingOptions: thinkingOptions.length > 0,
    thinkingUnavailable,
  });
  const controls = (
    <div className="flex max-w-full flex-wrap items-center justify-end gap-1.5">
      {provider ? (
        <ProviderModelPicker
          environmentId={environmentId}
          activeInstanceId={provider.instanceId}
          model={model}
          lockedProvider={provider.driver}
          {...(!model ? { triggerLabel: inheritModelLabel } : {})}
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
        // Without a live catalog the default model is still typed by hand.
        <DraftInput
          id={modelId}
          aria-label={modelField.label}
          size="sm"
          className="w-56 max-w-full"
          value={model}
          placeholder={modelField.placeholder}
          onCommit={onModelChange}
          spellCheck={false}
        />
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
          <SelectItem value="">{inheritThinkingLabel}</SelectItem>
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
      {provider && model ? (
        <Button size="xs" variant="ghost" onClick={() => onModelChange("")}>
          {inheritModelLabel}
        </Button>
      ) : null}
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
