import type { FileDiffMetadata } from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";

import { resolveDiffThemeName, resolveFileDiffPath } from "../../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../../lib/syntaxHighlighting";
import { DiffWorkerPoolProvider } from "../DiffWorkerPoolProvider";

/**
 * The diff in a review comment a user sent. Loaded lazily by the timeline so the
 * diff renderer and Shiki stay off the chat route's startup path.
 */
export default function ReviewCommentFileDiffs({
  files,
  resolvedTheme,
}: {
  readonly files: ReadonlyArray<FileDiffMetadata>;
  readonly resolvedTheme: "light" | "dark";
}) {
  return (
    <DiffWorkerPoolProvider>
      {files.map((fileDiff) => (
        <FileDiff
          key={resolveFileDiffPath(fileDiff)}
          fileDiff={fileDiff}
          options={{
            collapsed: false,
            diffStyle: "unified",
            theme: resolveDiffThemeName(resolvedTheme),
            preferredHighlighter: PREFERRED_HIGHLIGHTER,
          }}
        />
      ))}
    </DiffWorkerPoolProvider>
  );
}
