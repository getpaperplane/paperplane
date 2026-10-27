// @effect-diagnostics nodeBuiltinImport:off - the test builds a real git fixture on disk
// with synchronous node fs/child_process so it can run git directly against temp dirs.
import { assert, describe, it } from "@effect/vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ChildProcess from "node:child_process";

import * as ProcessRunner from "../processRunner.ts";
import * as AgentSkills from "./AgentSkills.ts";
import { redactGitDetail } from "./AgentSkills.ts";

const git = (cwd: string, args: ReadonlyArray<string>) =>
  ChildProcess.execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const writeSkill = (root: string, name: string, description: string) => {
  const dir = NodePath.join(root, name);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`,
  );
};

interface Fixture {
  readonly root: string;
  readonly remote: string;
  readonly skills: string;
  readonly otherClone: string;
}

/**
 * A temp root with a bare remote and a skills directory. Git reads only the
 * empty global config and the test identity, so the developer's config never
 * changes the outcome.
 */
const makeFixture = (): Fixture => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "agent-skills-"));
  const emptyGlobal = NodePath.join(root, "gitconfig");
  NodeFS.writeFileSync(emptyGlobal, "");
  process.env.GIT_CONFIG_GLOBAL = emptyGlobal;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  process.env.GIT_AUTHOR_NAME = "Test";
  process.env.GIT_AUTHOR_EMAIL = "test@example.com";
  process.env.GIT_COMMITTER_NAME = "Test";
  process.env.GIT_COMMITTER_EMAIL = "test@example.com";
  const remote = NodePath.join(root, "remote.git");
  git(root, ["init", "--bare", "-b", "main", remote]);
  return {
    root,
    remote,
    skills: NodePath.join(root, "machine-a", "skills"),
    otherClone: NodePath.join(root, "machine-b", "skills"),
  };
};

const layerFor = (directory: string) =>
  AgentSkills.layer({ directory, backgroundFetchInterval: false }).pipe(
    Layer.provide(ProcessRunner.layer),
    Layer.provide(NodeServices.layer),
  );

const runWith = <A, E>(directory: string, effect: Effect.Effect<A, E, AgentSkills.AgentSkills>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(layerFor(directory)), Effect.scoped) as Effect.Effect<A, E, never>,
  );

describe("AgentSkills", () => {
  it("lists skills in a plain folder without git", async () => {
    const fixture = makeFixture();
    writeSkill(fixture.skills, "alpha", "Does alpha things");
    NodeFS.mkdirSync(NodePath.join(fixture.skills, ".system"), { recursive: true });

    const status = await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.getStatus();
      }),
    );

    assert.isTrue(status.exists);
    assert.isNull(status.git);
    assert.deepStrictEqual(
      status.skills.map((skill) => [skill.name, skill.description]),
      [["alpha", "Does alpha things"]],
    );
    assert.lengthOf(status.skills[0]!.contentHash, 16);
  });

  it("initializes a repository with a first commit and pushes to a remote", async () => {
    const fixture = makeFixture();
    writeSkill(fixture.skills, "alpha", "Alpha");

    const status = await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.initRepository({ remoteUrl: fixture.remote });
      }),
    );

    assert.isNotNull(status.git);
    assert.strictEqual(status.git?.branch, "main");
    assert.strictEqual(status.git?.remoteUrl, fixture.remote);
    assert.isFalse(status.git?.dirty);
    assert.strictEqual(git(fixture.skills, ["log", "--format=%s", "-1"]), "Initial skills");
    assert.include(
      NodeFS.readFileSync(NodePath.join(fixture.skills, ".gitignore"), "utf8"),
      ".DS_Store",
    );
    assert.include(git(fixture.remote, ["branch", "--list", "main"]), "main");
  });

  it("reports behind after another machine pushes, then fast-forwards on sync", async () => {
    const fixture = makeFixture();
    writeSkill(fixture.skills, "alpha", "Alpha");
    await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.initRepository({ remoteUrl: fixture.remote });
      }),
    );
    // Machine B clones the shared remote and pushes a new skill.
    NodeFS.mkdirSync(NodePath.dirname(fixture.otherClone), { recursive: true });
    git(NodePath.dirname(fixture.otherClone), ["clone", fixture.remote, fixture.otherClone]);
    writeSkill(fixture.otherClone, "beta", "Beta");
    git(fixture.otherClone, ["add", "-A"]);
    git(fixture.otherClone, ["commit", "-m", "Add beta"]);
    git(fixture.otherClone, ["push", "origin", "main"]);

    const behind = await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.getStatus({ fetch: true });
      }),
    );
    assert.strictEqual(behind.git?.behind, 1);
    assert.strictEqual(behind.git?.ahead, 0);
    assert.isNotNull(behind.git?.lastFetchedAt);
    assert.isNull(behind.git?.lastError);

    const synced = await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.sync();
      }),
    );
    assert.strictEqual(synced.git?.behind, 0);
    assert.deepStrictEqual(synced.skills.map((skill) => skill.name).sort(), ["alpha", "beta"]);
  });

  it("commits and pushes a dirty local change on sync", async () => {
    const fixture = makeFixture();
    writeSkill(fixture.skills, "alpha", "Alpha");
    await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.initRepository({ remoteUrl: fixture.remote });
      }),
    );
    writeSkill(fixture.skills, "gamma", "Gamma");

    const dirty = await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.getStatus();
      }),
    );
    assert.isTrue(dirty.git?.dirty);

    const synced = await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.sync();
      }),
    );
    assert.isFalse(synced.git?.dirty);
    assert.strictEqual(synced.git?.ahead, 0);
    assert.include(git(fixture.skills, ["log", "--format=%s", "-1"]), "Update skills from");
    assert.include(git(fixture.remote, ["log", "--format=%s", "main"]), "Update skills from");
  });

  it("reports diverged and changes nothing when both sides moved", async () => {
    const fixture = makeFixture();
    writeSkill(fixture.skills, "alpha", "Alpha");
    await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.initRepository({ remoteUrl: fixture.remote });
      }),
    );
    NodeFS.mkdirSync(NodePath.dirname(fixture.otherClone), { recursive: true });
    git(NodePath.dirname(fixture.otherClone), ["clone", fixture.remote, fixture.otherClone]);
    writeSkill(fixture.otherClone, "beta", "Beta");
    git(fixture.otherClone, ["add", "-A"]);
    git(fixture.otherClone, ["commit", "-m", "Add beta"]);
    git(fixture.otherClone, ["push", "origin", "main"]);
    // Local commit on machine A, not yet pushed.
    writeSkill(fixture.skills, "delta", "Delta");
    git(fixture.skills, ["add", "-A"]);
    git(fixture.skills, ["commit", "-m", "Add delta"]);
    const localHead = git(fixture.skills, ["rev-parse", "HEAD"]);

    const status = await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.sync();
      }),
    );

    assert.isTrue(status.git?.diverged);
    assert.strictEqual(status.git?.ahead, 1);
    assert.strictEqual(status.git?.behind, 1);
    assert.include(status.git?.lastError ?? "", "resolve in");
    assert.strictEqual(git(fixture.skills, ["rev-parse", "HEAD"]), localHead);
  });

  it("joins an existing remote without diverging when this machine already had skills", async () => {
    const fixture = makeFixture();
    // Machine A seeds the remote with alpha (v1) and beta.
    NodeFS.mkdirSync(NodePath.dirname(fixture.skills), { recursive: true });
    writeSkill(fixture.skills, "alpha", "Alpha v1");
    writeSkill(fixture.skills, "beta", "Beta");
    await runWith(
      fixture.skills,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.initRepository({ remoteUrl: fixture.remote });
      }),
    );
    // Machine B is a plain folder with its own alpha (v2, different) and gamma.
    writeSkill(fixture.otherClone, "alpha", "Alpha v2 on machine B");
    writeSkill(fixture.otherClone, "gamma", "Gamma");

    const joined = await runWith(
      fixture.otherClone,
      Effect.gen(function* () {
        const service = yield* AgentSkills.AgentSkills;
        return yield* service.initRepository({ remoteUrl: fixture.remote });
      }),
    );

    assert.isFalse(joined.git?.diverged);
    assert.strictEqual(joined.git?.behind, 0);
    assert.strictEqual(joined.git?.ahead, 0);
    assert.deepStrictEqual(joined.skills.map((skill) => skill.name).sort(), [
      "alpha",
      "beta",
      "gamma",
    ]);
    // Remote wins on the shared path; the machine's own version survives in history.
    const alpha = NodeFS.readFileSync(
      NodePath.join(fixture.otherClone, "alpha", "SKILL.md"),
      "utf8",
    );
    assert.include(alpha, "Alpha v1");
    // The machine's own version is in the first parent, the "Initial skills" commit.
    assert.strictEqual(
      git(fixture.otherClone, ["log", "--format=%s", "-1", "HEAD^1"]),
      "Initial skills",
    );
    assert.include(
      git(fixture.otherClone, ["show", "HEAD^1:alpha/SKILL.md"]),
      "Alpha v2 on machine B",
    );
    assert.include(git(fixture.remote, ["ls-tree", "--name-only", "main", "gamma/"]), "gamma/");
  });
});

describe("redactGitDetail", () => {
  it("returns the first non-empty stderr line, trimmed", () => {
    assert.strictEqual(
      redactGitDetail("\n  \n  fatal: repository not found  \nmore"),
      "fatal: repository not found",
    );
    assert.isUndefined(redactGitDetail("  \n\n"));
  });

  it("masks credentials in URLs and caps the length", () => {
    assert.strictEqual(
      redactGitDetail("fatal: unable to access 'https://user:tok3n@github.com/o/r.git/': denied"),
      "fatal: unable to access 'https://***@github.com/o/r.git/': denied",
    );
    assert.strictEqual(redactGitDetail("x".repeat(500))?.length, 200);
  });
});
