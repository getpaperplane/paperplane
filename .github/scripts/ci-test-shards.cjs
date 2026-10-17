// LPT bins from GitHub-hosted ubuntu-24.04 run 39027419700 (seconds).
// Empty TEST_PACKAGES means every test-bearing workspace except dedicated jobs.
const { readWorkspace, OWN_TEST_JOB } = require("./ci-changes.cjs");
const weights = require("./ci-test-weights.json");

const DEFAULT_WEIGHT = 30;

function assignShards(packages, selected = "", count = 3) {
  if (!Number.isInteger(count) || count < 1) throw new Error("Invalid shard count");
  const requested = new Set(selected.split(/\s+/).filter(Boolean));
  const candidates = packages.filter((pkg) => pkg.hasTest && !OWN_TEST_JOB.has(pkg.name));
  for (const name of requested) {
    if (!candidates.some((pkg) => pkg.name === name)) {
      throw new Error(`Unknown test package: ${name}`);
    }
  }
  const names = [...new Set(candidates.map((pkg) => pkg.name))]
    .filter((name) => requested.size === 0 || requested.has(name))
    .sort((a, b) => weight(b) - weight(a) || a.localeCompare(b));
  const shards = Array.from({ length: count }, () => ({ packages: [], weight: 0 }));
  for (const name of names) {
    const shard = shards.reduce((best, next) => (next.weight < best.weight ? next : best));
    shard.packages.push(name);
    shard.weight += weight(name);
  }
  return shards;
}

function weight(name) {
  return weights[name] ?? DEFAULT_WEIGHT;
}

if (require.main === module) {
  const index = Number(process.argv[2]);
  const shards = assignShards(
    readWorkspace(),
    process.env.TEST_PACKAGES,
    Number(process.argv[3] ?? 3),
  );
  if (!Number.isInteger(index) || index < 1 || index > shards.length) {
    throw new Error("Invalid shard index");
  }
  const shard = shards[index - 1];
  console.error(
    `Shard ${index}: ${shard.weight}s recorded package time: ${shard.packages.join(", ")}`,
  );
  console.log(`packages=${shard.packages.join(" ")}`);
  console.log(`has_packages=${shard.packages.length > 0}`);
  console.log(`desktop=${shard.packages.includes("@rove-code/desktop")}`);
}

module.exports = { assignShards, DEFAULT_WEIGHT };
