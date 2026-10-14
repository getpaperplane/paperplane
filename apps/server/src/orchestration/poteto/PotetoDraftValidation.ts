import { PotetoDraftResult } from "@rove-code/contracts";
import * as Schema from "effect/Schema";
import { validatePotetoProjectSpec } from "./PotetoProjectRunner.ts";

const decodeDraft = Schema.decodeUnknownSync(PotetoDraftResult);

/** SDK-free validation shared by the server and the isolated Pi worker. */
export function validatePotetoDraft(
  value: unknown,
  files: ReadonlyArray<{ readonly path: string; readonly content: string }>,
): PotetoDraftResult {
  const result = decodeDraft(value);
  if (result.status === "unsupported") return result;
  const spec = validatePotetoProjectSpec(result.spec);
  const available = new Set(files.map((file) => file.path));
  for (const path of [...spec.editableFiles, ...spec.contextFiles, spec.check.module]) {
    if (!available.has(path))
      throw new Error("Draft references a file outside the committed snapshot.");
  }
  return { status: "draft", spec };
}
