import {
  MAX_WEBHOOK_DELIVERY_AGE_MINUTES,
  type ScheduledTaskUpsertSchedule,
  type ScheduledTaskWebhookDeliveryOutcome,
} from "@getpaperplane/contracts";

/** Prompt a new webhook task starts with: just the body, so request headers stay out unless the user adds them. */
export const DEFAULT_WEBHOOK_PROMPT = "Handle this webhook:\n{{body}}";

/** Blank means "no limit"; undefined means the input is not a valid limit, which blocks saving. */
export function parseMaxDeliveryAge(value: string): number | null | undefined {
  if (value.trim() === "") return null;
  const minutes = Number(value.trim());
  return Number.isInteger(minutes) && minutes > 0 && minutes <= MAX_WEBHOOK_DELIVERY_AGE_MINUTES
    ? minutes
    : undefined;
}

/** GitHub's signature settings, the most common sender. */
export const WEBHOOK_SIGNATURE_DEFAULTS = {
  signatureHeader: "x-hub-signature-256",
  signatureEncoding: "hex",
  signaturePrefix: "sha256=",
} as const;

type WebhookUpsertSignature = Extract<
  NonNullable<ScheduledTaskUpsertSchedule>,
  { type: "webhook" }
>["signature"];

/**
 * The signature to send on save. A blank secret is omitted so the server keeps
 * the stored one; a disabled check sends null so the server removes it.
 */
export function webhookSignatureForUpsert(input: {
  readonly enabled: boolean;
  readonly header: string;
  readonly encoding: "hex" | "base64";
  readonly prefix: string;
  readonly secret: string;
}): WebhookUpsertSignature {
  if (!input.enabled) return null;
  const secret = input.secret.trim();
  return {
    header: input.header.trim(),
    encoding: input.encoding,
    prefix: input.prefix,
    ...(secret ? { secret } : {}),
  };
}

/** Whether saving would leave a signature check without a header or any secret to verify with. */
export function webhookSignatureIncomplete(
  signature: WebhookUpsertSignature,
  hasStoredSecret: boolean,
): boolean {
  return Boolean(signature && (!signature.header || (!signature.secret && !hasStoredSecret)));
}

export const WEBHOOK_DELIVERY_OUTCOME_LABELS: Record<ScheduledTaskWebhookDeliveryOutcome, string> =
  {
    accepted: "Ran",
    dispatch_failed: "Run failed",
    rejected_signature: "Bad signature",
    disabled: "Task paused",
    rate_limited: "Rate limited",
    expired: "Too old",
  };

export function webhookDeliveryOutcomeTone(
  outcome: ScheduledTaskWebhookDeliveryOutcome,
): "success" | "warning" | "error" {
  if (outcome === "accepted") return "success";
  if (outcome === "disabled" || outcome === "rate_limited" || outcome === "expired") {
    return "warning";
  }
  return "error";
}

/**
 * Header lines for display. The server already redacts credential-named
 * headers; this also masks any signature header configured on the task, whose
 * name may not look like a credential.
 */
export function webhookDeliveryHeaderLines(
  headers: Readonly<Record<string, string>>,
  signatureHeader: string | null,
): string[] {
  const masked = signatureHeader?.trim().toLowerCase();
  return Object.entries(headers).map(
    ([name, value]) => `${name}: ${name.toLowerCase() === masked ? "[redacted]" : value}`,
  );
}
