import { BaseSequencer, type TestSpecification } from "vite-plus/test/node";
import weights from "./test-shard-weights.json" with { type: "json" };

const recorded: Record<string, number> = weights;
const values = Object.values(recorded).sort((a, b) => a - b);
const median = values[Math.floor(values.length / 2)] ?? 1;

/**
 * Splits server test files across CI shards (`--shard i/n`) by recorded
 * duration instead of Vitest's path hash, which left one shard running more
 * than twice as long as another. Files run one at a time per shard
 * (`fileParallelism: false`), so the slowest shard is the CI critical path.
 *
 * `test-shard-weights.json` holds each file's wall-clock seconds, import time
 * included, from a CI run's server shard logs. Files missing from it count as
 * the median. Stale weights only cost balance, never coverage: every shard
 * computes the same assignment from the same inputs.
 */
export class DurationShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { root, shard } = this.ctx.config;
    if (!shard) return files;
    const weighted = files
      .map((spec) => {
        // As in Vitest's own sequencer: module IDs are absolute and use `/`.
        const path = spec.moduleId
          .replaceAll("\\", "/")
          .slice(root.replaceAll("\\", "/").length + 1);
        return { spec, path, weight: recorded[path] ?? median };
      })
      .sort((a, b) => b.weight - a.weight || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    // Longest-first greedy: each file goes to the currently lightest shard.
    const loads = Array.from({ length: shard.count }, () => 0);
    const mine: TestSpecification[] = [];
    for (const file of weighted) {
      let lightest = 0;
      for (let index = 1; index < loads.length; index++) {
        if (loads[index]! < loads[lightest]!) lightest = index;
      }
      loads[lightest]! += file.weight;
      if (lightest === shard.index - 1) mine.push(file.spec);
    }
    return mine;
  }
}
