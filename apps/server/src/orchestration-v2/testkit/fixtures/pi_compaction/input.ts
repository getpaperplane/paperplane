import type { OrchestratorFixtureInput } from "../shared.ts";

export const PI_COMPACTION_MARKER = "compaction-marker-4Z7Q";
const PI_COMPACTION_RECALL_PROMPT =
  "Return the opaque marker I asked you to remember. Respond with only the marker.";

/**
 * Two SDK compactions: refusal on a small session, then success and recall.
 * The shipping adapter supports bare /compact only, so both use compactThread.
 * These deterministic SDK events preserve the original RPC scenario's semantics
 * without claiming that its CLI-only custom-instructions path ships in Paperplane.
 */
export function piCompactionInput(): OrchestratorFixtureInput {
  return {
    steps: [
      {
        type: "message",
        text: `Remember the opaque marker ${PI_COMPACTION_MARKER} for later. Respond with exactly: compaction marker stored`,
      },
      { type: "message", text: "/compact" },
      { type: "message", text: "Respond with exactly: second compaction fixture turn" },
      { type: "message", text: "Respond with exactly: third compaction fixture turn" },
      { type: "message", text: "/compact" },
      { type: "message", text: PI_COMPACTION_RECALL_PROMPT },
    ],
  };
}
