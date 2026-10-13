import { describe, expect, it } from "vite-plus/test";
import { cloneDirectoryName, sandboxCloneUrl } from "./remoteSandbox";

describe("sandboxCloneUrl", () => {
  it("clones GitHub SSH remotes over HTTPS", () => {
    expect(sandboxCloneUrl("git@github.com:hafiezul/rove.git")).toBe(
      "https://github.com/hafiezul/rove.git",
    );
    expect(sandboxCloneUrl("ssh://git@github.com/hafiezul/rove")).toBe(
      "https://github.com/hafiezul/rove.git",
    );
  });
  it("leaves other remotes alone", () => {
    expect(sandboxCloneUrl("https://github.com/hafiezul/rove.git")).toBe(
      "https://github.com/hafiezul/rove.git",
    );
    expect(sandboxCloneUrl("git@gitlab.com:a/b.git")).toBe("git@gitlab.com:a/b.git");
  });
});

it("names the clone folder after the repository", () => {
  expect(cloneDirectoryName("git@github.com:hafiezul/rove.git")).toBe("rove");
  expect(cloneDirectoryName("https://example.com/a/b/")).toBe("b");
});
