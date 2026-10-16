import type { LucideIcon } from "lucide-react";

/**
 * Every Lucide icon as its own lazily loaded module, for icons chosen by name at
 * runtime (project icons). Import this module lazily: the loader map has an entry
 * per icon.
 *
 * The `?project-icon` query gives these modules ids distinct from the icons the
 * app imports statically from `lucide-react`. `lucide-react/dynamic` imports the
 * same files the static imports use, which made every statically used icon a
 * dynamic entry too, so the bundler emitted each one as its own tiny chunk on
 * the startup path.
 */
const iconModules = import.meta.glob<LucideIcon>(
  ["/node_modules/lucide-react/dist/esm/icons/*.js", "!**/index.js"],
  { query: "?project-icon", import: "default" },
);

const iconLoaders = new Map(
  Object.entries(iconModules).map(([path, load]) => [
    path.slice(path.lastIndexOf("/") + 1, -".js".length),
    load,
  ]),
);

export const lucideIconNames: ReadonlyArray<string> = [...iconLoaders.keys()];

export function loadLucideIcon(name: string): Promise<LucideIcon> | null {
  return iconLoaders.get(name)?.() ?? null;
}
