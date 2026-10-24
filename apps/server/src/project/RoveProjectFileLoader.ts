/**
 * RoveProjectFileLoader - Effect service that loads the checked-in `paperplane.json`
 * project file from a workspace root.
 *
 * Loading is best-effort: a missing file resolves to `Option.none`, and
 * unreadable or invalid files are logged and treated as absent so callers
 * can fall back to their defaults.
 *
 * @module RoveProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  PAPERPLANE_PROJECT_FILE_NAME,
  type ProjectConfigState,
  type PaperplaneProjectFile,
} from "@getpaperplane/contracts";
import { PaperplaneProjectFileFromJson } from "@getpaperplane/shared/paperplaneProjectFile";

const decodeRoveProjectFileJson = Schema.decodeEffect(PaperplaneProjectFileFromJson);

export class RoveProjectFileLoadError extends Schema.TaggedError<RoveProjectFileLoadError>()(
  "RoveProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${PAPERPLANE_PROJECT_FILE_NAME} at ${this.filePath}.`;
  }
}

/** Service tag for paperplane.json project file loading. */
export class RoveProjectFileLoader extends Context.Service<
  RoveProjectFileLoader,
  {
    /**
     * Load and decode `paperplane.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<PaperplaneProjectFile>>;
    /** Report missing, invalid, or legacy-only configuration without parsing the legacy file. */
    readonly loadState: (workspaceRoot: string) => Effect.Effect<ProjectConfigState>;
  }
>()("@getpaperplane/server/project/RoveProjectFileLoader") {}

const logRoveProjectFileLoadError = (error: RoveProjectFileLoadError) =>
  Effect.logWarning(error).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const loadState: RoveProjectFileLoader["Service"]["loadState"] = Effect.fn(
    "RoveProjectFileLoader.loadState",
  )(function* (workspaceRoot): Effect.fn.Return<ProjectConfigState> {
    const filePath = path.join(workspaceRoot, PAPERPLANE_PROJECT_FILE_NAME);
    const raw = yield* Effect.result(fileSystem.readFileString(filePath));
    if (raw._tag === "Failure") {
      if (raw.failure.reason._tag === "NotFound") {
        // Existence only: even malformed or unreadable legacy files need the rename notice.
        const legacyExists = yield* fileSystem
          .exists(path.join(workspaceRoot, "rove.json"))
          .pipe(Effect.catch(() => Effect.succeed(false)));
        return { status: legacyExists ? "legacy-only" : "missing" };
      }
      yield* logRoveProjectFileLoadError(
        new RoveProjectFileLoadError({
          operation: "read",
          workspaceRoot,
          filePath,
          cause: raw.failure,
        }),
      );
      return { status: "invalid" };
    }
    return yield* decodeRoveProjectFileJson(raw.success).pipe(
      Effect.map((file): ProjectConfigState => ({ status: "valid", file })),
      Effect.catchTags({
        SchemaError: (cause) =>
          logRoveProjectFileLoadError(
            new RoveProjectFileLoadError({ operation: "decode", workspaceRoot, filePath, cause }),
          ).pipe(Effect.as<ProjectConfigState>({ status: "invalid" })),
      }),
    );
  });

  const load: RoveProjectFileLoader["Service"]["load"] = Effect.fn("RoveProjectFileLoader.load")(
    (workspaceRoot) =>
      loadState(workspaceRoot).pipe(
        Effect.map((state) => (state.status === "valid" ? Option.some(state.file) : Option.none())),
      ),
  );

  return RoveProjectFileLoader.of({ load, loadState });
});

export const layer = Layer.effect(RoveProjectFileLoader, make);
