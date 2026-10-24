import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadEnvMode, WorktreeSubmodules } from "./environment.ts";
import { ProjectScriptIcon } from "./project.ts";
import type { ProjectScopedServerSettingKey, ServerSettings } from "./settings.ts";

/** File name of the checked-in Paperplane project file, resolved at the workspace root. */
export const PAPERPLANE_PROJECT_FILE_NAME = "paperplane.json";

/** Public URL of the published JSON Schema for {@link PaperplaneProjectFile}. */
export const PAPERPLANE_PROJECT_FILE_SCHEMA_URL =
  "https://paperplane.hafiezulzikry.com/schema/paperplane.json";

const PAPERPLANE_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const PAPERPLANE_PROJECT_FILE_MAX_SCRIPTS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const PaperplaneProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the Paperplane scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a Paperplane terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  runOnSettle: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs in the thread's worktree each time the thread settles, for example to delete build output. Threads without their own worktree skip it.",
    }),
  ),
  async: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "Only for runOnWorktreeCreate scripts. When true (the default), the agent starts while the script is still running. Set false to hold the agent until the script exits.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into Paperplane.",
});
export type PaperplaneProjectFileScript = typeof PaperplaneProjectFileScript.Type;

export const PaperplaneProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${PAPERPLANE_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before Paperplane\'s built-in icon locations.',
      },
      PAPERPLANE_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    ThreadEnvMode.annotate({
      description:
        'Where new threads start for this repository: "worktree" for a fresh git worktree, "local" for the current checkout. A per-project setting in Paperplane overrides this; when neither is set, the global default applies.',
    }),
  ),
  worktreeSubmodules: Schema.optionalKey(
    WorktreeSubmodules.annotate({
      description:
        'How new worktrees populate git submodules: "recursive" (the default) initializes nested submodules too, "top-level" initializes only those declared by this repository, and "none" leaves every submodule empty for a setup script to handle. A project or environment setting in Paperplane overrides this.',
    }),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(PaperplaneProjectFileScript)
      .annotate({
        description:
          "Project scripts shared with everyone who opens this repository in Paperplane.",
      })
      .check(Schema.isMaxLength(PAPERPLANE_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "Paperplane project file",
  description:
    "Checked-in project configuration for Paperplane (paperplane.json at the repository root). See https://github.com/hafiezul/rove/blob/main/docs/user/project-settings.md for documentation.",
});
export type PaperplaneProjectFile = typeof PaperplaneProjectFile.Type;

/** Server-owned configuration state; the legacy filename is detected, never read. */
export const ProjectConfigState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("valid"), file: PaperplaneProjectFile }),
  Schema.Struct({ status: Schema.Literals(["missing", "invalid", "legacy-only"]) }),
]);
export type ProjectConfigState = typeof ProjectConfigState.Type;

/**
 * Settings a repository can also declare in paperplane.json. A key here must be
 * nullable on `ServerSettings` (null means inherit) so both the project
 * override and the environment value can defer to the file; `field` names
 * the paperplane.json field carrying the same value and `builtIn` is what applies
 * when every tier is unset. `resolveProjectSettings` walks project override,
 * environment value, file, built-in, so listing a key here is the whole
 * change for a new file-backed setting.
 */
export const PROJECT_FILE_BACKED_SETTINGS = {
  defaultThreadEnvMode: { field: "defaultThreadEnvMode", builtIn: "local" },
  worktreeSubmodules: { field: "worktreeSubmodules", builtIn: "recursive" },
} as const satisfies {
  // `providerInstances` is scoped per project but overrides field by field
  // rather than replacing a whole `ServerSettings` value (see its doc comment
  // in settings.ts), so it cannot be file-backed and is excluded here.
  readonly [K in ProjectScopedServerSettingKey & keyof ServerSettings]?: {
    readonly field: {
      readonly [F in keyof PaperplaneProjectFile]: PaperplaneProjectFile[F] extends
        | Exclude<ServerSettings[K], null>
        | undefined
        ? F
        : never;
    }[keyof PaperplaneProjectFile];
    readonly builtIn: Exclude<ServerSettings[K], null>;
  };
};
export type ProjectFileBackedSettingKey = keyof typeof PROJECT_FILE_BACKED_SETTINGS;

/**
 * `ServerSettings` with every file-backed key resolved to a concrete value.
 * What `resolveProjectSettings(...).settings` produces once a paperplane.json (or
 * its absence) has been accounted for.
 */
export type ResolvedServerSettings = Omit<ServerSettings, ProjectFileBackedSettingKey> & {
  readonly [K in ProjectFileBackedSettingKey]: Exclude<ServerSettings[K], null>;
};
