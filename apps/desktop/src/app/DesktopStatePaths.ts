import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(paperplaneHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(paperplaneHome)) {
    return Option.none();
  }
  const trimmed = paperplaneHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly paperplaneHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.paperplaneHome), () =>
    input.joinPath(input.homeDirectory, ".paperplane"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly paperplaneHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.paperplaneHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
