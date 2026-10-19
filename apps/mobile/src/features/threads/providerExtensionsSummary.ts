export interface ProviderExtensionsSummaryInput {
  readonly data: {
    readonly extensions: ReadonlyArray<unknown>;
    readonly warnings: ReadonlyArray<unknown>;
    readonly compatibilityWarnings?: ReadonlyArray<unknown> | undefined;
  } | null;
  readonly error: string | null;
  readonly isPending: boolean;
}

/** Short value for the thread settings row: "12", "12 · 2 issues", "Loading…", "Error". */
export function summarizeProviderExtensions(resources: ProviderExtensionsSummaryInput): string {
  if (resources.data === null) {
    if (resources.error) return "Error";
    return resources.isPending ? "Loading…" : "";
  }
  const issues =
    resources.data.warnings.length + (resources.data.compatibilityWarnings?.length ?? 0);
  const count = String(resources.data.extensions.length);
  return issues > 0 ? `${count} · ${issues} ${issues === 1 ? "issue" : "issues"}` : count;
}
