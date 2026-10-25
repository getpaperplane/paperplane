import { describe, expect, it } from "vite-plus/test";
import { cloneDirectoryName, sandboxCloneUrl } from "./remoteSandbox";

describe("sandboxCloneUrl", () => {
  it("clones GitHub SSH remotes over HTTPS", () => {
    expect(sandboxCloneUrl("git@github.com:getpaperplane/paperplane.git")).toBe(
      "https://github.com/getpaperplane/paperplane.git",
    );
    expect(sandboxCloneUrl("ssh://git@github.com/getpaperplane/paperplane")).toBe(
      "https://github.com/getpaperplane/paperplane.git",
    );
  });
  it("leaves other remotes alone", () => {
    expect(sandboxCloneUrl("https://github.com/getpaperplane/paperplane.git")).toBe(
      "https://github.com/getpaperplane/paperplane.git",
    );
    expect(sandboxCloneUrl("git@gitlab.com:a/b.git")).toBe("git@gitlab.com:a/b.git");
  });
});

it("names the clone folder after the repository", () => {
  expect(cloneDirectoryName("git@github.com:getpaperplane/paperplane.git")).toBe("paperplane");
  expect(cloneDirectoryName("https://example.com/a/b/")).toBe("b");
});
