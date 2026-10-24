import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { prepareProfileMigration } from "./DesktopMigration.ts";

export class DesktopUserDataInitializationError extends Schema.TaggedError<DesktopUserDataInitializationError>()(
  "DesktopUserDataInitializationError",
  {
    operation: Schema.Literals(["inspect", "migrate"]),
    resourcePath: Schema.String,
    category: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error
      ? this.cause.message
      : `Could not initialize Electron user data during ${this.operation} at ${this.resourcePath} (${this.category}).`;
  }
}

/** Select an independent profile, completing the one-time copy before Chromium opens it. */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: {
    readonly appDataDirectory: string;
    readonly isDevelopment: boolean;
    readonly platform: NodeJS.Platform;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const destination = path.join(
      input.appDataDirectory,
      input.isDevelopment ? "paperplane-dev" : "paperplane",
    );
    const inspect = (resourcePath: string) =>
      fs.exists(resourcePath).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopUserDataInitializationError({
              operation: "inspect",
              resourcePath,
              category: cause.reason._tag,
              cause,
            }),
        ),
      );
    if (yield* inspect(destination)) return destination;
    // All retired identity names and copying stay inside the deletable migration module.
    return yield* Effect.try({
      try: () => prepareProfileMigration(input),
      catch: (cause) =>
        new DesktopUserDataInitializationError({
          operation: "migrate",
          resourcePath: destination,
          category: "MigrationFailed",
          cause,
        }),
    });
  },
);
