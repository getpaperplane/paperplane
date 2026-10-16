import type { LucideIcon } from "lucide-react";
import { useEffect, useReducer, type ComponentType } from "react";

const loadedIcons = new Map<string, LucideIcon | null>();
const pendingIcons = new Map<string, Promise<void>>();

function loadIcon(name: string): Promise<void> {
  let pending = pendingIcons.get(name);
  if (!pending) {
    pending = import("~/lib/lucideIconModules")
      .then(({ loadLucideIcon }) => loadLucideIcon(name))
      .then((icon) => {
        loadedIcons.set(name, icon ?? null);
      })
      .finally(() => pendingIcons.delete(name));
    pendingIcons.set(name, pending);
  }
  return pending;
}

/**
 * A Lucide icon chosen by name at runtime, such as a project icon. Renders
 * `fallback` while the icon loads and when the name is unknown; once loaded, an
 * icon renders synchronously everywhere it appears.
 */
export function NamedLucideIcon({
  name,
  className,
  fallback: Fallback,
}: {
  readonly name: string;
  readonly className?: string | undefined;
  readonly fallback: ComponentType<{ className?: string | undefined }>;
}) {
  const [, rerender] = useReducer((count: number) => count + 1, 0);
  const Icon = loadedIcons.get(name);

  useEffect(() => {
    if (loadedIcons.has(name)) return;
    let active = true;
    loadIcon(name).then(
      () => active && rerender(),
      (error) => console.error(error),
    );
    return () => {
      active = false;
    };
  }, [name]);

  return Icon ? <Icon className={className} /> : <Fallback className={className} />;
}
