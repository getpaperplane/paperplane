import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

// Only product-owned messages cross the driver boundary. Vendor messages,
// details and command output may contain credentials, so never forward them.
export class SandboxDriverError extends Error {}

const decodeBoatError = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(
      Schema.Union([Schema.String, Schema.Struct({ code: Schema.optionalKey(Schema.String) })]),
    ),
  }),
);

const billingMessage =
  "Boat requires billing setup or compute credit. Complete trial/subscription checkout or add credit in the Boat dashboard, then try again.";
const credentialsMessage =
  "Boat rejected the API key. Check that it is valid and has not expired or been revoked, then save a new key.";
const capacityMessage =
  "Your Boat account has reached its running sandbox limit. Pause an unused sandbox in the Boat dashboard, then try again.";
const rateMessage =
  "Boat's request or sandbox-start limit has been reached. Wait for the limit to reset, then try again.";

const boatErrorMessages = new Map([
  [
    "subscription_required",
    "Boat requires a trial or subscription. Complete checkout in the Boat dashboard, then try again.",
  ],
  ["billing_required", billingMessage],
  [
    "insufficient_credits",
    "Your Boat account has no compute credit left. Add credit in the Boat dashboard, then try again.",
  ],
  [
    "trial_auto_stop_required",
    "Boat trial accounts require auto-stop within two hours. Paperplane currently requests unlimited runtime; use a paid Boat plan or Modal instead.",
  ],
  [
    "trial_machine_class_not_allowed",
    "This machine size is not available on your Boat trial. Check your plan in the Boat dashboard.",
  ],
  [
    "machine_class_plan_required",
    "This machine size requires a higher Boat plan. Check your plan in the Boat dashboard.",
  ],
  [
    "team_member_cap_reached",
    "Your Boat organization usage cap has been reached. Ask the organization owner to raise your cap.",
  ],
  [
    "org_suspended",
    "Your Boat organization wallet is suspended. Ask the organization owner to check billing in the Boat dashboard.",
  ],
  ["unauthorized", credentialsMessage],
  ["api_key_expired", credentialsMessage],
  [
    "api_key_action_forbidden",
    "This Boat API key does not have permission for this operation. Create a key with sandbox lifecycle permissions in the Boat dashboard.",
  ],
  [
    "api_key_sandbox_forbidden",
    "This Boat API key cannot access this sandbox. Use a key that includes this sandbox or its environment.",
  ],
  [
    "claim_required",
    "Your Boat account has not been claimed. Complete account setup in the Boat dashboard, then try again.",
  ],
  [
    "account_not_ready",
    "Your Boat account is not ready to start compute. Complete account and billing setup in the Boat dashboard, then try again.",
  ],
  ["rate_limited", rateMessage],
  [
    "daily_limit_reached",
    "Your Boat daily sandbox-start limit has been reached. Wait for it to reset or upgrade your plan in the Boat dashboard.",
  ],
  ["limit_reached", capacityMessage],
  [
    "member_limit_reached",
    "Your Boat organization member limit has been reached. Ask the organization owner to review your limits.",
  ],
  ["no_ready_machine", "Boat has no machine available right now. Try again later."],
  [
    "machine_not_running",
    "The Boat sandbox is not running. Resume it before trying this operation again.",
  ],
  [
    "sandbox_not_ready",
    "The Boat sandbox is not ready. Check its state in the Boat dashboard and resume or repair it.",
  ],
]);

export function boatRequestError(status: number, body: unknown): SandboxDriverError {
  const decoded = decodeBoatError(body);
  const code = Option.isSome(decoded)
    ? (decoded.value.code ??
      (Predicate.isString(decoded.value.error) ? decoded.value.error : decoded.value.error?.code))
    : undefined;
  const knownMessage = code === undefined ? undefined : boatErrorMessages.get(code);
  const statusMessage =
    status === 401
      ? credentialsMessage
      : status === 402
        ? billingMessage
        : status === 403
          ? "Boat denied this operation. Check the API key's permissions and your account plan in the Boat dashboard."
          : status === 404
            ? "Boat could not find this resource. Check the Boat dashboard and refresh saved state."
            : status === 429
              ? rateMessage
              : status >= 500
                ? "Boat could not complete the request. Check the Boat dashboard for existing resources before retrying."
                : "Boat rejected the request. Check your account and sandbox state in the Boat dashboard before retrying.";
  return new SandboxDriverError(`${knownMessage ?? statusMessage} (HTTP ${status})`);
}

const decodeModalError = Schema.decodeUnknownOption(
  Schema.Struct({
    code: Schema.optionalKey(Schema.Int),
    name: Schema.optionalKey(Schema.String),
  }),
);
const modalCredentialsMessage =
  "Modal rejected the token. Check the token ID and secret, then save valid credentials for the intended workspace.";
const modalLimitMessage =
  "Modal reports a resource or quota limit. Check your workspace's compute limits and billing in the Modal dashboard before retrying.";
const modalTimeoutMessage =
  "The Modal operation timed out. Check the Modal dashboard for existing resources before retrying.";
const modalInvalidMessage =
  "Modal rejected the sandbox configuration. Check the image, volume mounts and workspace settings in the Modal dashboard.";
const modalMissingMessage =
  "Modal could not find the sandbox or a recovery resource. Check the Modal dashboard before deleting this record.";

// gRPC status codes, not free-form SDK/server messages.
const modalStatusMessages = new Map([
  [3, modalInvalidMessage],
  [4, modalTimeoutMessage],
  [5, modalMissingMessage],
  [
    7,
    "Modal denied this operation. Check the token's workspace permissions and your workspace's billing in the Modal dashboard.",
  ],
  [8, modalLimitMessage],
  [
    9,
    "Modal cannot complete this operation in the resource's current state. Check the sandbox and workspace settings in the Modal dashboard.",
  ],
  [
    14,
    "Could not reach Modal. Check the managing environment's internet connection and the Modal dashboard before retrying.",
  ],
  [16, modalCredentialsMessage],
]);
const modalSdkMessages = new Map([
  ["ResourceExhaustedError", modalLimitMessage],
  ["TimeoutError", modalTimeoutMessage],
  ["SandboxTimeoutError", modalTimeoutMessage],
  ["InvalidError", modalInvalidMessage],
  ["NotFoundError", modalMissingMessage],
  [
    "AlreadyExistsError",
    "A Modal resource with this name already exists. Check it in the Modal dashboard before retrying.",
  ],
  [
    "SnapshotCreationError",
    "Modal could not save a recovery snapshot. Check the sandbox in the Modal dashboard before pausing or deleting it.",
  ],
]);

export async function modalOperation<A>(run: () => Promise<A>): Promise<A> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof SandboxDriverError) throw error;
    const decoded = decodeModalError(error);
    if (Option.isSome(decoded)) {
      const { code, name } = decoded.value;
      const message =
        (code === undefined ? undefined : modalStatusMessages.get(code)) ??
        (name === undefined ? undefined : modalSdkMessages.get(name));
      if (message)
        throw new SandboxDriverError(`${message}${code === undefined ? "" : ` (gRPC ${code})`}`);
    }
    // The manager retains its operation-specific fallback for unknown errors.
    throw error;
  }
}
