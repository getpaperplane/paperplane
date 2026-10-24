const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { test } = require("node:test");
const { readWorkspace, OWN_TEST_JOB } = require("./ci-changes.cjs");
const { assignShards, DEFAULT_WEIGHT } = require("./ci-test-shards.cjs");

const pkg = (name, hasTest = true) => ({ name, hasTest });
const names = (shards) => shards.flatMap((shard) => shard.packages).sort();

test("full workspace covers every test package exactly once, excluding dedicated jobs", () => {
  const workspace = readWorkspace();
  const shards = assignShards(workspace);
  const expected = workspace
    .filter((p) => p.hasTest && !OWN_TEST_JOB.has(p.name))
    .map((p) => p.name)
    .sort();
  assert.deepEqual(names(shards), expected);
  assert.equal(new Set(names(shards)).size, expected.length);
  assert.equal(shards.length, 3);
  // Recorded totals should be nearly equal, not three chunks of manifest order.
  const totals = shards.map((shard) => shard.weight);
  assert.ok(Math.max(...totals) - Math.min(...totals) <= DEFAULT_WEIGHT);
  assert.deepEqual(assignShards(workspace.toReversed()), shards);
});

test("selected packages are rebalanced, with no unaffected packages", () => {
  const selected = "@getpaperplane/shared @getpaperplane/client-runtime rove-relay @getpaperplane/provider-pi";
  const shards = assignShards(readWorkspace(), selected);
  assert.deepEqual(names(shards), selected.split(" ").sort());
  assert.deepEqual(
    shards.map((s) => s.weight),
    [147, 132, 215],
  );
});

test("unknown new workspace packages get a default weight and no-test packages are omitted", () => {
  assert.deepEqual(assignShards([pkg("new"), pkg("no-tests", false)], "", 1), [
    { packages: ["new"], weight: DEFAULT_WEIGHT },
  ]);
});

test("few selected packages leave explicit empty shards; whitespace and duplicates are harmless", () => {
  const shards = assignShards(readWorkspace(), "  @getpaperplane/shared\n@getpaperplane/shared  ");
  assert.deepEqual(shards, [
    { packages: ["@getpaperplane/shared"], weight: 84 },
    { packages: [], weight: 0 },
    { packages: [], weight: 0 },
  ]);
});

test("invalid selections and shard counts fail instead of silently skipping tests", () => {
  assert.throws(() => assignShards([], "missing"), /Unknown test package/);
  assert.throws(() => assignShards(readWorkspace(), "@getpaperplane/server"), /Unknown test package/);
  for (const count of [0, -1, 1.5, NaN]) {
    assert.throws(() => assignShards([], "", count), /Invalid shard count/);
  }
});

test("CLI emits safe empty-shard outputs, and marks desktop prerequisites", () => {
  const script = path.join(__dirname, "ci-test-shards.cjs");
  const run = (index) =>
    spawnSync(process.execPath, [script, String(index), "3"], {
      env: { ...process.env, TEST_PACKAGES: "@getpaperplane/desktop" },
      encoding: "utf8",
    });
  assert.equal(run(1).status, 0);
  assert.equal(run(1).stdout, "packages=@getpaperplane/desktop\nhas_packages=true\ndesktop=true\n");
  assert.equal(run(2).stdout, "packages=\nhas_packages=false\ndesktop=false\n");
  assert.notEqual(run(0).status, 0);
});
