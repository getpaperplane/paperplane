import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import {
  checkReleaseIdentity,
  findOldNameIdentifiers,
  findUpstreamPublicIdentity,
} from "./check-release-identity.mjs";

it("flags public upstream identities, not compatibility names or attribution", () => {
  expect(findUpstreamPublicIdentity('import "@t3tools/contracts"; // read t3.json')).toEqual([]);
  expect(findUpstreamPublicIdentity("The fork is based on T3 Code.")).toEqual([]);
  expect(
    findUpstreamPublicIdentity("npx t3@nightly\nhttps://t3.codes/install.sh\nowner: 'pingdotgg'"),
  ).toEqual([
    { line: 1, text: "npx t3@nightly" },
    { line: 2, text: "https://t3.codes/install.sh" },
    { line: 3, text: "owner: 'pingdotgg'" },
  ]);
});

it("allows the upstream credit without hiding other identities on the same line", () => {
  const attribution =
    '<p>Built on <a href="https://github.com/pingdotgg/t3code">T3 Code</a>. Taking our own path.</p>';
  expect(findUpstreamPublicIdentity(attribution)).toEqual([]);
  for (const identity of ["npx t3@nightly", "https://t3.codes", "owner: 'pingdotgg'"]) {
    const line = `${attribution} ${identity}`;
    expect(findUpstreamPublicIdentity(line)).toEqual([{ line: 1, text: line }]);
  }
  expect(
    findUpstreamPublicIdentity('<a href="https://github.com/pingdotgg/other">T3 Code</a>'),
  ).toHaveLength(1);
});

it.each([
  "https://github.com/hafiezul/rove",
  "https://rove.hafiezulzikry.com",
  "https://rove-nightly.hafiezulzikry.com",
  "https://rove-code.hafiezulzikry.com/install.sh",
  "rove-relay",
  "Rove-Code-1.2.3-arm64.dmg",
  "Rove Code Release Signing",
  "io.github.hafiezul.rove",
  "ROVE_HOME",
  "roveMcpApp",
  "PiRoveTools",
])("reports retired identity %s", (source) => {
  expect(findOldNameIdentifiers("apps/server/src/example.ts", source)).toEqual([
    { file: "apps/server/src/example.ts", line: 1, text: source },
  ]);
});

it("checks file names and avoids words, upstream attribution and opaque image bytes", () => {
  expect(findOldNameIdentifiers("scripts/rove-tool.ts", "// no old content")).toEqual([
    { file: "scripts/rove-tool.ts", line: 0, text: "old-name file path" },
  ]);
  expect(
    findOldNameIdentifiers(
      "README.md",
      "improve approved APPROVED grove approveWith Prove\nhttps://github.com/pingdotgg/t3code",
    ),
  ).toEqual([]);
  expect(
    findOldNameIdentifiers("art.svg", '<image href="data:image/png;base64,roveROVE"/>'),
  ).toEqual([]);
  expect(
    findOldNameIdentifiers("art.svg", '<image href="data:image/png;base64,AAA"/> rove-relay'),
  ).toHaveLength(1);
});

it.each([
  ["packages/shared/src/homeMigration.ts", 'const old = ".rove-code";'],
  ["apps/desktop/src/app/DesktopMigration.test.ts", 'profile: "rove-v2"'],
  [
    "infra/relay/migrations/postgres/20261005152602_rove-default-label/migration.sql",
    "Rove Environment",
  ],
  [".repos/example/index.ts", "Rove Code"],
  ["patches/example.patch", "Rove Code"],
  ["apps/server/src/orchestration-v2/testkit/fixtures/example/replay.ndjson", "Rove Code"],
  ["docs/user/install.md", "Quit Rove Code before copying ~/.rove-code."],
  ["apps/server/src/computerUse/MacosVm.ts", 'const vm = "rove-cua-golden";'],
  [".github/scripts/thread-transfer-report.cjs", "<!-- rove-thread-transfer-report -->"],
  ["apps/server/src/project/PaperplaneProjectFileLoader.ts", 'exists("rove.json")'],
  [
    "apps/mobile/src/lib/attachmentUpload.test.ts",
    'uri: "file:///documents/rove-composer-attachments/a.pdf"',
  ],
])("allows explicit migration/history at %s", (file, source) => {
  expect(findOldNameIdentifiers(file, source)).toEqual([]);
});

it.each([
  ["infra/relay/migrations/postgres/20990101000000_new/migration.sql", "Rove Environment"],
  ["apps/server/src/example.test.ts", 'const url = "https://rove.hafiezulzikry.com";'],
  ["apps/server/src/computerUse/Other.ts", 'const vm = "rove-cua-golden";'],
  [".github/scripts/thread-transfer-report.cjs", "<!-- rove-thread-transfer-report --> rove-relay"],
  [
    "apps/server/src/computerUse/MacosVm.ts",
    'const vm = "rove-cua-golden"; const pkg = "rove-relay";',
  ],
  [
    "packages/shared/src/git.ts",
    'branch = "rove/deadbeef"; url = "https://github.com/hafiezul/rove";',
  ],
  ["docs/user/install.md", "Quit Rove Code. Download https://github.com/hafiezul/rove"],
  ["apps/mobile/src/lib/attachmentUpload.test.ts", '"rove-composer-attachments"; "rove-relay";'],
])("does not broaden history exemptions at %s", (file, source) => {
  expect(findOldNameIdentifiers(file, source)).toHaveLength(1);
});

it("reports all public claims but only gates upstream claims; stray repository names always block", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "paperplane-release-identity-"));
  const files = {
    "apps/marketing/src/pages/download.astro": "npx t3@nightly\n",
    "apps/marketing/astro.config.mjs": "site: undefined\n",
    "apps/marketing/wrangler.json": "{}\n",
    "apps/web/vercel.ts": "host: 'app.t3.codes'\n",
    "apps/mobile/app.config.ts": "relyingParty: 'clerk.t3.codes'\n",
    "apps/mobile/eas.json": '{ "ascAppId": "6787819824" }\n',
    "apps/mobile/src/features/settings/lib/legal-document-url.ts":
      "const site = 'https://t3.codes';\n",
  };
  for (const [file, content] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(root, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, file), content);
  }

  const messages = [];
  const previousLog = console.log;
  const previousError = console.error;
  console.log = (...args) => messages.push(args.join(" "));
  console.error = (...args) => messages.push(args.join(" "));
  const check = (env = {}) => checkReleaseIdentity(root, env, Object.keys(files));
  try {
    expect(check()).toBe(true);
    expect(check({ PAPERPLANE_MARKETING_RELEASE_READY: "true" })).toBe(false);
    expect(check({ PAPERPLANE_HOSTED_RELEASE_READY: "true" })).toBe(false);
    expect(check({ PAPERPLANE_MOBILE_STORES_READY: "true" })).toBe(false);
    expect(check({ PAPERPLANE_MOBILE_SIDELOAD_READY: "true" })).toBe(false);
    NodeFS.writeFileSync(NodePath.join(root, "apps/mobile/app.config.ts"), "// Paperplane\n");
    NodeFS.writeFileSync(
      NodePath.join(root, "apps/mobile/src/features/settings/lib/legal-document-url.ts"),
      "// Paperplane\n",
    );
    // Store-only metadata still does not enable stores or block sideload builds.
    expect(check({ PAPERPLANE_MOBILE_SIDELOAD_READY: "true" })).toBe(true);
    expect(check({ PAPERPLANE_MOBILE_STORES_READY: "true" })).toBe(false);
    expect(messages.join("\n")).toMatch(
      /apps\/marketing\/src\/pages\/download\.astro:1: npx t3@nightly/,
    );
    expect(messages.join("\n")).toMatch(/Refusing publication for: marketing/);
    expect(messages.join("\n")).toMatch(/apps\/mobile\/eas\.json:1:/);

    NodeFS.writeFileSync(
      NodePath.join(root, "apps/marketing/wrangler.json"),
      '{ "name": "rove-marketing" }',
    );
    expect(check()).toBe(false);
    expect(messages.join("\n")).toMatch(/Repository identity: 1 stray old-name identifiers/);
    expect(messages.join("\n")).toMatch(/Refusing publication for: repository identity/);
  } finally {
    console.log = previousLog;
    console.error = previousError;
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
