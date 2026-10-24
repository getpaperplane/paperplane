import type { ProjectConfigState, RoveProjectFileScript } from "@getpaperplane/contracts";

const NO_SCRIPTS: ReadonlyArray<RoveProjectFileScript> = [];

/** Present only the configuration the server accepted, never a legacy file's contents. */
export function resolveProjectConfigState(data: ProjectConfigState | null, isPending = false) {
  const status = data?.status ?? (isPending ? "loading" : "missing");
  const file = data?.status === "valid" ? data.file : null;
  return {
    status,
    file,
    scripts: file?.scripts ?? NO_SCRIPTS,
    notice:
      status === "legacy-only"
        ? "Rename rove.json to paperplane.json to apply this checkout's project settings and scripts. rove.json is no longer read."
        : status === "invalid"
          ? "paperplane.json is invalid or unreadable. Its project settings, scripts, and icon are ignored. Check the JSON syntax, values, and file permissions."
          : null,
  };
}
