"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  type EnvironmentId,
  type ServerProvider,
  type ServerProviderModel,
} from "@getpaperplane/contracts";
import { PlusIcon, XIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { SecretInput } from "./SecretInput";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import type { ProviderClientDefinition } from "@getpaperplane/provider-core/client";

/** What the form reads from a definition: an agent provider's, or a source control host's. */
export type SettingsFormDefinition = Pick<ProviderClientDefinition, "settingsSchema"> & {
  readonly driverKind?: ProviderClientDefinition["driverKind"];
};
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
  type ProviderSettingsFieldModel,
} from "@getpaperplane/client-runtime/state/provider-instance-settings";
import { PiModelSettings } from "./PiModelSettings";
import { SettingsRow } from "./settingsLayout";

export { deriveProviderSettingsFields, nextProviderConfigWithFieldValue };
export type { ProviderSettingsFieldModel };

let commandArgumentDraftId = 0;
const makeCommandArgumentDraftRow = (value: string) => ({
  id: `provider-argument-${commandArgumentDraftId++}`,
  value,
});

function commandArgumentsEqual(left: ReadonlyArray<string>, right: ReadonlyArray<string>) {
  return left.length === right.length && left.every((argument, index) => argument === right[index]);
}

function ProviderCommandArguments({
  value,
  onChange,
}: Pick<ProviderSettingsFormProps, "value" | "onChange">) {
  const args = useMemo(() => {
    const configured =
      value !== null && typeof value === "object"
        ? (value as Record<string, unknown>).commandArgs
        : undefined;
    return Array.isArray(configured)
      ? configured.filter((argument): argument is string => typeof argument === "string")
      : [];
  }, [value]);
  const [rows, setRows] = useState(() => args.map(makeCommandArgumentDraftRow));
  const rowsRef = useRef(rows);
  const previousArgsRef = useRef(args);
  const lastPublishedArgsRef = useRef<ReadonlyArray<string> | undefined>(undefined);

  useEffect(() => {
    const previousArgs = previousArgsRef.current;
    const lastPublishedArgs = lastPublishedArgsRef.current;
    previousArgsRef.current = args;
    lastPublishedArgsRef.current = undefined;
    if (
      commandArgumentsEqual(previousArgs, args) ||
      (lastPublishedArgs !== undefined && commandArgumentsEqual(lastPublishedArgs, args))
    )
      return;
    const nextRows = args.map(makeCommandArgumentDraftRow);
    rowsRef.current = nextRows;
    setRows(nextRows);
  }, [args]);

  const updateArguments = (nextRows: typeof rows) => {
    rowsRef.current = nextRows;
    setRows(nextRows);
    const next = nextRows.map((row) => row.value);
    lastPublishedArgsRef.current = next;
    const config =
      value !== null && typeof value === "object" ? { ...(value as Record<string, unknown>) } : {};
    onChange({ ...config, commandArgs: next });
  };

  return (
    <SettingsRow
      title="Arguments"
      description="One literal argument per row, in launch order."
      control={
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => updateArguments([...rowsRef.current, makeCommandArgumentDraftRow("")])}
        >
          <PlusIcon />
          Add argument
        </Button>
      }
    >
      {rows.length > 0 ? (
        <div className="mt-3 min-w-0 space-y-2 pb-2">
          {rows.map((argument, index) => (
            <div key={argument.id} className="flex min-w-0 items-center gap-1.5">
              <DraftInput
                size="sm"
                font="mono"
                value={argument.value}
                onCommit={(next) =>
                  updateArguments(
                    rowsRef.current.map((current) =>
                      current.id === argument.id ? { ...current, value: next } : current,
                    ),
                  )
                }
                aria-label={`Argument ${index + 1}`}
                spellCheck={false}
              />
              <Button
                type="button"
                size="icon-micro"
                variant="ghost-destructive"
                onClick={() =>
                  updateArguments(rowsRef.current.filter((current) => current.id !== argument.id))
                }
                aria-label={`Remove argument ${index + 1}`}
              >
                <XIcon />
              </Button>
            </div>
          ))}
        </div>
      ) : null}
    </SettingsRow>
  );
}

interface ProviderSettingsFormProps {
  readonly definition: SettingsFormDefinition;
  readonly value: unknown;
  readonly environmentId?: EnvironmentId | null | undefined;
  readonly provider?: ServerProvider | undefined;
  readonly models?: ReadonlyArray<ServerProviderModel> | undefined;
  readonly supportsPiWorkloadProtection?: boolean | undefined;
  readonly idPrefix: string;
  /**
   * `card` stacks label over control, `dialog` is the compact wizard layout,
   * and `settings` renders the shared settings row treatment.
   */
  readonly variant: "card" | "dialog" | "settings";
  readonly onChange: (nextConfig: Record<string, unknown> | undefined) => void;
}

/** Stores the default choice as an omitted key so unchanged configs stay small. */
function ProviderSettingsSelect({
  field,
  value,
  inputId,
  size,
  className,
  onChange,
}: {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly inputId: string;
  readonly size: "sm" | "xs";
  readonly className?: string | undefined;
  readonly onChange: ProviderSettingsFormProps["onChange"];
}) {
  const options = field.options ?? [];
  const fallback = options[0]?.value ?? "";
  const current = readProviderConfigString(value, field.key) || fallback;
  const label = options.find((option) => option.value === current)?.label ?? current;
  return (
    <Select
      value={current}
      onValueChange={(next) => {
        if (typeof next !== "string") return;
        onChange(nextProviderConfigWithFieldValue(value, field, next === fallback ? "" : next));
      }}
    >
      <SelectTrigger id={inputId} size={size} className={className} aria-label={field.label}>
        <SelectValue>{label}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="start" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

function FieldFrame(props: {
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly children: ReactNode;
}) {
  if (props.variant === "card") {
    return <div>{props.children}</div>;
  }
  return <div className="grid gap-1.5">{props.children}</div>;
}

interface ProviderSettingsFieldRowProps {
  readonly field: ProviderSettingsFieldModel;
  readonly value: unknown;
  readonly idPrefix: string;
  readonly variant: ProviderSettingsFormProps["variant"];
  readonly onChange: ProviderSettingsFormProps["onChange"];
}

function ProviderSettingsFieldRow({
  field,
  value,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFieldRowProps) {
  const inputId = `${idPrefix}-${field.key}`;
  const descriptionClassName =
    variant === "dialog"
      ? "text-2xs text-muted-foreground"
      : "mt-1 block text-xs text-muted-foreground";
  const label = <span className="text-xs font-medium text-foreground">{field.label}</span>;
  const description = field.description ? (
    <span className={descriptionClassName}>{field.description}</span>
  ) : null;

  if (variant === "settings") {
    const descriptionId = field.description ? `${inputId}-description` : undefined;
    const control =
      field.control === "switch" ? (
        <Switch
          checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
          onCheckedChange={(checked) =>
            onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
          }
          aria-label={field.label}
          aria-describedby={descriptionId}
        />
      ) : field.control === "select" ? (
        <ProviderSettingsSelect
          field={field}
          value={value}
          inputId={inputId}
          size="sm"
          className="w-full max-w-full @min-[32rem]/settings-row:w-56"
          onChange={onChange}
        />
      ) : field.control === "textarea" ? (
        <Textarea
          id={inputId}
          aria-describedby={descriptionId}
          className="w-full max-w-full @min-[32rem]/settings-row:w-[min(24rem,50cqw)]"
          value={readProviderConfigString(value, field.key)}
          onChange={(event) =>
            onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
          }
          placeholder={field.placeholder}
          spellCheck={false}
        />
      ) : field.secret ? (
        <SecretInput
          id={inputId}
          aria-describedby={descriptionId}
          size="sm"
          className="w-full max-w-full @min-[32rem]/settings-row:w-56"
          configured={readProviderConfigString(value, field.key).length > 0}
          value=""
          onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
        />
      ) : (
        <DraftInput
          id={inputId}
          aria-describedby={descriptionId}
          size="sm"
          className="w-full max-w-full @min-[32rem]/settings-row:w-56"
          type={field.control === "password" ? "password" : undefined}
          autoComplete={field.control === "password" ? "off" : undefined}
          value={readProviderConfigString(value, field.key)}
          placeholder={field.placeholder}
          onCommit={(next) => {
            onChange(nextProviderConfigWithFieldValue(value, field, next));
          }}
          spellCheck={false}
        />
      );

    return (
      <SettingsRow
        title={
          field.control === "switch" ? field.label : <label htmlFor={inputId}>{field.label}</label>
        }
        description={
          field.description ? <span id={descriptionId}>{field.description}</span> : undefined
        }
        control={control}
      />
    );
  }

  if (field.control === "switch") {
    return (
      <FieldFrame variant={variant}>
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            {label}
            {description}
          </div>
          <Switch
            checked={readProviderConfigBoolean(value, field.key, field.defaultBooleanValue)}
            onCheckedChange={(checked) =>
              onChange(nextProviderConfigWithFieldValue(value, field, Boolean(checked)))
            }
            aria-label={field.label}
          />
        </div>
      </FieldFrame>
    );
  }

  if (field.control === "select") {
    return (
      <FieldFrame variant={variant}>
        <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
          {label}
          <ProviderSettingsSelect
            field={field}
            value={value}
            inputId={inputId}
            size="sm"
            className={cn("w-full", variant === "card" && "mt-1.5")}
            onChange={onChange}
          />
          {description}
        </label>
      </FieldFrame>
    );
  }

  if (field.control === "textarea") {
    return (
      <FieldFrame variant={variant}>
        <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
          {label}
          <Textarea
            id={inputId}
            className={cn(variant === "card" && "mt-1.5")}
            value={readProviderConfigString(value, field.key)}
            onChange={(event) =>
              onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
            }
            placeholder={field.placeholder}
            spellCheck={false}
          />
          {description}
        </label>
      </FieldFrame>
    );
  }

  const type = field.control === "password" ? "password" : undefined;
  const BufferedInput = field.secret ? SecretInput : DraftInput;
  const ControlledInput = field.secret ? SecretInput : Input;
  return (
    <FieldFrame variant={variant}>
      <label htmlFor={inputId} className={cn(variant === "card" && "block")}>
        {label}
        {variant === "card" ? (
          <BufferedInput
            id={inputId}
            size="sm"
            className="mt-1.5"
            type={field.secret ? undefined : type}
            autoComplete={!field.secret && field.control === "password" ? "off" : undefined}
            value={readProviderConfigString(value, field.key)}
            onCommit={(next) => onChange(nextProviderConfigWithFieldValue(value, field, next))}
            placeholder={field.placeholder}
            spellCheck={false}
          />
        ) : (
          <ControlledInput
            id={inputId}
            type={field.secret ? undefined : type}
            autoComplete={!field.secret && field.control === "password" ? "off" : undefined}
            value={readProviderConfigString(value, field.key)}
            onChange={(event) =>
              onChange(nextProviderConfigWithFieldValue(value, field, event.target.value))
            }
            placeholder={field.placeholder}
            spellCheck={false}
          />
        )}
        {description}
      </label>
    </FieldFrame>
  );
}

export function ProviderSettingsForm({
  definition,
  value,
  environmentId = null,
  provider,
  models,
  supportsPiWorkloadProtection = false,
  idPrefix,
  variant,
  onChange,
}: ProviderSettingsFormProps) {
  const fields = useMemo(
    () => deriveProviderSettingsFields(definition, value, supportsPiWorkloadProtection),
    [definition, value, supportsPiWorkloadProtection],
  );
  const isLocalAcp =
    definition.driverKind === "acpRegistry" &&
    readProviderConfigString(value, "source") === "local";

  if (fields.length === 0) {
    return null;
  }

  const piModelField =
    definition.driverKind === "pi" ? fields.find((field) => field.key === "model") : undefined;
  const piThinkingField = piModelField
    ? fields.find((field) => field.key === "thinkingLevel")
    : undefined;
  const piModelPair =
    piModelField && piThinkingField
      ? { modelField: piModelField, thinkingField: piThinkingField }
      : undefined;

  return (
    <>
      {fields.map((field) => {
        if (piModelPair?.thinkingField.key === field.key) return null;
        const pair = piModelPair?.modelField.key === field.key ? piModelPair : undefined;
        return pair ? (
          <PiModelSettings
            key={field.key}
            environmentId={environmentId}
            provider={provider}
            models={models}
            modelField={pair.modelField}
            thinkingField={pair.thinkingField}
            value={value}
            idPrefix={idPrefix}
            variant={variant}
            onModelChange={(next) =>
              onChange(nextProviderConfigWithFieldValue(value, pair.modelField, next))
            }
            onThinkingChange={(next) =>
              onChange(nextProviderConfigWithFieldValue(value, pair.thinkingField, next))
            }
          />
        ) : (
          <ProviderSettingsFieldRow
            key={field.key}
            field={field}
            value={value}
            idPrefix={idPrefix}
            variant={variant}
            onChange={onChange}
          />
        );
      })}
      {isLocalAcp ? <ProviderCommandArguments value={value} onChange={onChange} /> : null}
    </>
  );
}
