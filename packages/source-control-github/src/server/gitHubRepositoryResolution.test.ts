import { assert, describe, it } from "@effect/vitest";

import {
  gitHubApiHostForRemote,
  gitHubRepositoryForContextRemote,
  selectGitHubBaseRepository,
} from "./gitHubRepositoryResolution.ts";

describe("selectGitHubBaseRepository", () => {
  const remotes = (...entries: ReadonlyArray<readonly [string, string]>) =>
    entries
      .flatMap(([name, url]) => [`${name}\t${url} (fetch)`, `${name}\t${url} (push)`])
      .join("\n");
  const select = (input: { remotes: string; resolved?: string }) =>
    selectGitHubBaseRepository({ resolved: "", host: "github.com", ...input });

  it("picks the repository gh reads without a prompt", () => {
    assert.deepStrictEqual(select({ remotes: remotes(["fork", "git@github.com:me/web.git"]) }), {
      owner: "me",
      name: "web",
    });
    const fork = remotes(
      ["origin", "git@github.com:me/web.git"],
      ["upstream", "https://github.com/Acme/Web.git"],
    );
    assert.deepStrictEqual(select({ remotes: fork }), { owner: "acme", name: "web" });
    assert.deepStrictEqual(select({ remotes: fork, resolved: "remote.origin.gh-resolved base" }), {
      owner: "me",
      name: "web",
    });
    assert.deepStrictEqual(
      select({ remotes: fork, resolved: "remote.origin.gh-resolved acme/other" }),
      { owner: "acme", name: "other" },
    );
    // gh ranks remote names in any case.
    assert.deepStrictEqual(
      select({
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["Upstream", "git@github.com:acme/web.git"],
        ),
      }),
      { owner: "acme", name: "web" },
    );
  });

  it("leaves gh to choose when it might weigh the remotes differently", () => {
    for (const input of [
      { remotes: "" },
      {
        remotes: remotes(["a", "git@github.com:me/web.git"], ["b", "git@github.com:acme/web.git"]),
      },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["mirror", "git@gitlab.com:me/web.git"],
        ),
      },
      { remotes: remotes(["origin", "git@github-work:me/web.git"]) },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["Origin", "git@github.com:acme/web.git"],
        ),
      },
      {
        remotes: remotes(
          ["origin", "git@github.com:me/web.git"],
          ["upstream", "git@github.com:acme/web.git"],
        ),
        resolved: "remote.origin.gh-resolved base\nremote.upstream.gh-resolved base",
      },
    ]) {
      assert.strictEqual(select(input), null);
    }
  });
});

describe("gitHubRepositoryForContextRemote", () => {
  it.each([
    ["git@github.com:Acme/Web.git", "github.com"],
    ["git@github:acme/web.git", "github.com"],
    ["git@github-work:acme/web.git", "github.com"],
    ["ssh://git@github-work/acme/web.git", "github.com"],
    ["git@code.example.test:acme/web.git", "code.example.test"],
    ["ssh://git@code.example.test/acme/web.git", "code.example.test"],
    ["https://code.example.test/acme/web.git", "code.example.test"],
  ])("resolves %s on %s", (remoteUrl, host) => {
    assert.deepStrictEqual(gitHubRepositoryForContextRemote(remoteUrl), {
      host,
      owner: "acme",
      name: "web",
    });
  });

  it.each([
    ["git@code.example.test:acme/web.git", "code.example.test:8443", "code.example.test:8443"],
    ["git@ssh.example.test:acme/web.git", "api.example.test:8443", "api.example.test:8443"],
    ["git@github.com:acme/web.git", "explicit.example.test", "explicit.example.test"],
    ["git@github-work:acme/web.git", "github-work", "github.com"],
  ])("uses the host hint for %s: %s", (remoteUrl, hostHint, host) => {
    assert.deepStrictEqual(gitHubRepositoryForContextRemote(remoteUrl, hostHint), {
      host,
      owner: "acme",
      name: "web",
    });
  });

  it.each(["", "not-a-remote", "git@github.com:web.git", "https://github.com/acme/web/extra"])(
    "leaves an unparseable repository to remote selection: %s",
    (remoteUrl) => {
      assert.strictEqual(gitHubRepositoryForContextRemote(remoteUrl), null);
    },
  );
});

describe("gitHubApiHostForRemote", () => {
  it("reads an SSH alias through github.com and a real host as itself", () => {
    assert.strictEqual(gitHubApiHostForRemote("git@github:acme/web.git"), "github.com");
    assert.strictEqual(
      gitHubApiHostForRemote("git@github.example.com:a/b.git"),
      "github.example.com",
    );
    assert.strictEqual(gitHubApiHostForRemote("git@gitlab.com:a/b.git"), null);
  });
});
