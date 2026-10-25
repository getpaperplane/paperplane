import * as Config from "effect/Config";
import * as Schema from "effect/Schema";

export const WindowsSigningModeConfig = Config.schema(
  Schema.Literals(["azure", "self-signed"]),
  "PAPERPLANE_WINDOWS_SIGNING_MODE",
).pipe(Config.withDefault("azure"));
