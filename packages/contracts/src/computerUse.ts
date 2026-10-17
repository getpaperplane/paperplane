import * as Schema from "effect/Schema";

/** Cua Driver's own macOS grants, read from its daemon; `null` when the daemon did not answer. */
export const ComputerUsePermissions = Schema.Struct({
  accessibility: Schema.Boolean,
  screenRecording: Schema.Boolean,
});
export type ComputerUsePermissions = typeof ComputerUsePermissions.Type;

export const ComputerUseDiagnostic = Schema.Struct({
  label: Schema.String,
  status: Schema.Literals(["ok", "warn", "err"]),
  message: Schema.String,
  detail: Schema.optional(Schema.String),
});
export type ComputerUseDiagnostic = typeof ComputerUseDiagnostic.Type;

/** Lume's version is reported separately from the guest driver. Sizes are bytes. */
export const ComputerUseMacosVm = Schema.Struct({
  state: Schema.Literals(["unavailable", "missing-lume", "needs-image", "needs-consent", "ready"]),
  leased: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  owners: Schema.Array(Schema.String),
  installCommand: Schema.String,
  requiredDiskBytes: Schema.Number,
  freeDiskBytes: Schema.optionalKey(Schema.Number),
  diskBytes: Schema.optionalKey(Schema.Number),
  virtualDiskBytes: Schema.optionalKey(Schema.Number),
  memoryBytes: Schema.optionalKey(Schema.Number),
  lumeVersion: Schema.optionalKey(Schema.String),
  setupCommand: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
});
export type ComputerUseMacosVm = typeof ComputerUseMacosVm.Type;

export const ComputerUseReadiness = Schema.Union([
  Schema.Struct({
    platform: Schema.Literal("darwin"),
    permissions: Schema.NullOr(ComputerUsePermissions),
    mode: Schema.optionalKey(Schema.Literal("host")),
  }),
  Schema.Struct({
    platform: Schema.Literal("darwin"),
    mode: Schema.Literal("isolated-vm"),
    permissions: Schema.Null,
    vm: ComputerUseMacosVm,
  }),
  /** Windows has no TCC grants; permissions are not applicable. */
  Schema.Struct({
    platform: Schema.Literal("win32"),
    permissions: Schema.Null,
  }),
  Schema.Struct({
    platform: Schema.Literal("linux"),
    diagnostics: Schema.NullOr(Schema.NonEmptyArray(ComputerUseDiagnostic)),
    desktops: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    capacity: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  }),
]);
export type ComputerUseReadiness = typeof ComputerUseReadiness.Type;

/** Cua's own usage-data preference; `null` when it could not be read. */
const Telemetry = Schema.NullOr(Schema.Boolean);

/** Cua Driver on the environment's host, from absent to ready. */
export const ComputerUseStatus = Schema.Union([
  Schema.Struct({ status: Schema.Literal("unsupported"), platform: Schema.String }),
  Schema.Struct({
    status: Schema.Literal("not-installed"),
    platform: Schema.Literals(["darwin", "linux", "win32"]),
  }),
  Schema.Struct({ status: Schema.Literal("runtime-unavailable"), detail: Schema.String }),
  Schema.Struct({ status: Schema.Literal("needs-desktop-image") }),
  /** The installed driver failed platform-specific signature or release-checksum verification. */
  Schema.Struct({ status: Schema.Literal("untrusted") }),
  Schema.Struct({
    status: Schema.Literal("stopped"),
    version: Schema.String,
    telemetry: Telemetry,
    readiness: ComputerUseReadiness,
  }),
  Schema.Struct({
    status: Schema.Literal("running"),
    version: Schema.String,
    telemetry: Telemetry,
    readiness: ComputerUseReadiness,
  }),
]);
export type ComputerUseStatus = typeof ComputerUseStatus.Type;

export const ComputerUseControlInput = Schema.Union([
  Schema.Struct({ action: Schema.Literal("install") }),
  Schema.Struct({ action: Schema.Literal("start") }),
  Schema.Struct({ action: Schema.Literal("prepare-vm") }),
  Schema.Struct({ action: Schema.Literal("verify-vm") }),
  Schema.Struct({ action: Schema.Literal("release-vm") }),
  Schema.Struct({ action: Schema.Literal("remove-vm") }),
  Schema.Struct({ action: Schema.Literal("grant-permissions") }),
  Schema.Struct({ action: Schema.Literal("set-telemetry"), enabled: Schema.Boolean }),
]);
export type ComputerUseControlInput = typeof ComputerUseControlInput.Type;

export const ComputerUseAction = Schema.Literals([
  "install",
  "start",
  "grant-permissions",
  "set-telemetry",
  "prepare-vm",
  "verify-vm",
  "release-vm",
  "remove-vm",
]);
export type ComputerUseAction = typeof ComputerUseAction.Type;

export class ComputerUseControlError extends Schema.TaggedError<ComputerUseControlError>()(
  "ComputerUseControlError",
  { action: ComputerUseAction, detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
