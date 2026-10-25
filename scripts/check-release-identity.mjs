#!/usr/bin/env node
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const upstreamPublicIdentity =
  /t3\.codes|T3 Tools|@t3dotgg|\bnpx\s+t3(?:@|\b)|\bpingdotgg\b|d763fcb8-d37c-41ea-a773-b54a0ab4a454|ARK85ZXQ4Z|\b6787819824\b/i;

// This exact link credits the upstream project; it is not Paperplane's public identity.
const upstreamAttributionLink = '<a href="https://github.com/pingdotgg/t3code">T3 Code</a>';

const surfaces = [
  {
    name: "marketing",
    readiness: "PAPERPLANE_MARKETING_RELEASE_READY",
    paths: [
      "apps/marketing/src",
      "apps/marketing/astro.config.mjs",
      "apps/marketing/wrangler.json",
    ],
  },
  {
    name: "hosted web",
    readiness: "PAPERPLANE_HOSTED_RELEASE_READY",
    paths: ["apps/web/vercel.ts"],
  },
  {
    name: "mobile sideload",
    readiness: "PAPERPLANE_MOBILE_SIDELOAD_READY",
    paths: [
      "apps/mobile/app.config.ts",
      "apps/mobile/src/features/settings/lib/legal-document-url.ts",
    ],
  },
  {
    name: "mobile stores",
    readiness: "PAPERPLANE_MOBILE_STORES_READY",
    paths: [
      "apps/mobile/app.config.ts",
      "apps/mobile/eas.json",
      "apps/mobile/src/features/settings/lib/legal-document-url.ts",
    ],
  },
];

function sourceFiles(root, entry) {
  const absolute = NodePath.join(root, entry);
  if (!NodeFS.statSync(absolute).isDirectory()) return [entry];
  return NodeFS.readdirSync(absolute, { withFileTypes: true }).flatMap((child) =>
    child.isDirectory()
      ? sourceFiles(root, NodePath.join(entry, child.name))
      : /\.(?:astro|mjs|ts|tsx)$/.test(child.name)
        ? [NodePath.join(entry, child.name)]
        : [],
  );
}

export function findUpstreamPublicIdentity(source) {
  return source
    .split(/\r?\n/)
    .flatMap((line, index) =>
      upstreamPublicIdentity.test(line.replaceAll(upstreamAttributionLink, ""))
        ? [{ line: index + 1, text: line.trim() }]
        : [],
    );
}

// These units exist solely to consume or warn about the old identity. Keep this
// list deletable with the migration, rather than exempting feature directories.
const migrationUnits = new Set([
  "packages/shared/src/homeMigration.ts",
  "packages/shared/src/homeMigration.test.ts",
  "packages/shared/src/clientMigration.ts",
  "packages/shared/src/clientMigration.test.ts",
  "packages/shared/src/savedDataMigration.test.ts",
  "packages/shared/src/legacyEnvironment.ts",
  "packages/shared/src/legacyEnvironment.test.ts",
  "apps/desktop/src/app/DesktopMigration.ts",
  "apps/desktop/src/app/DesktopMigration.test.ts",
  "apps/desktop/src/app/DesktopLegacyLocalStorage.test.ts",
  "apps/server/src/cloud/installedStateMigration.ts",
  "apps/server/src/cloud/installedStateMigration.test.ts",
]);

// Immutable ledgers only: a future migration is not automatically exempt.
const historicalRelayMigrations = new Set([
  "20260527044716_baseline",
  "20260601225421_add_mobile_device_label",
  "20260603035812_managed_endpoint_allocations",
  "20260706061126_migration",
  "20260727115225_migration",
  "20260727144838_migration",
  "20260906042516_android_devices",
  "20260918175607_long_thread_ids",
  "20260919015455_managed_endpoint_recovery",
  "20261004061459_hold_webhooks_while_offline",
  "20261005152602_rove-default-label",
  "20261005232034_managed_endpoint_tunnel_released_at",
]);

// Match token families, not words such as improve, approved, or grove.
const oldIdentity =
  /(?<![A-Za-z0-9])(?:rove|Rove|ROVE)(?=$|[^A-Za-z])|\b(?:Rove|rove)(?=[A-Z])|(?<=[a-z])Rove(?=[A-Z])|\broverelay\b|\brovecode\b/g;

const historicalDocs = new Set([
  "README.md",
  "docs/README.md",
  "docs/operations/release.md",
  "docs/operations/connect-setup.md",
  "docs/operations/cloudflare-web.md",
  "docs/user/background-service.md",
  "docs/user/install.md",
  "docs/user/project-settings.md",
  "docs/user/remote-access.md",
  "docs/user/snap-shot.md",
  "docs/user/source-control.md",
]);

// Scoped, token-level exceptions: an allowed token must not hide another old
// identity on the same line. Reasons for retained external resources live at
// their readers (Tart VMs, Modal handles, bot comments, branches and cgroups).
const retainedIdentities = [
  // The operator cutover explicitly lists the resources to delete, not reuse.
  [
    /^docs\/operations\/cloudflare-web\.md$/,
    /rove-web(?:-nightly)?|rove-marketing|rove(?:-nightly|-code)?\.hafiezulzikry\.com/g,
  ],
  [
    /^\.github\/scripts\/thread-transfer-report(?:\.test)?\.cjs$/,
    /rove-thread-transfer-(?:report|result-sha)/g,
  ],
  [
    /^apps\/server\/src\/computerUse\/MacosVm(?:\.test)?\.ts$/,
    /rove-cua-(?:golden|work-1|foreign)/g,
  ],
  [
    /^apps\/server\/src\/sandbox\/drivers\.ts$/,
    /rove-thread-sandboxes|rove-\$\{handle\.remoteId\}/g,
  ],
  [
    /^packages\/shared\/src\/git(?:\.test)?\.ts$/,
    /\brove[/-](?:<8 hex>|<uuid>|[a-f0-9-]+|(?=`))|(?<=\|)rove(?=\))|legacy rove temporary/g,
  ],
  [
    /^apps\/server\/src\/vcs\/worktreeProcesses(?:\.test)?\.ts$/,
    /(?<=\|)rove(?=\))|(?:app-)?rove(?:-(?:provider-)?workloads|-provider|-budget-x)?(?:\.slice|\.scope)|rove\.service/g,
  ],
  // The live relay deployment's identity (Alchemy stack, tunnels, Axiom
  // resources). Renaming any of it deploys a second relay; see alchemy.run.ts.
  [
    /^(?:infra\/relay\/|docs\/operations\/(?:connect-setup|relay-observability|release)\.md$|\.github\/workflows\/release\.yml$|apps\/server\/src\/scheduledTasks\/ScheduledTaskService\.webhook\.test\.ts$)/,
    /\bRoveRelay\b|roverelay-managedendpoint|rove-(?:relay-(?:traces|otel-ingest|client-otel-ingest|recent-spans)|mobile-otel-ingest)/g,
  ],
  // Warning-only detection of old project files, and protection of old homes.
  [
    /^(?:apps\/server\/(?:src\/(?:project\/(?:PaperplaneProjectFileLoader|AgentSessionScanner)|vcs\/VcsProjectConfig)|scripts\/(?:migrate-dev-db|paperplane-sqlite-state))|packages\/client-runtime\/src\/projectConfig)(?:\.test)?\.ts$/,
    /\.rove-code|\.rove|rove\.json|Rove Code/g,
  ],
  // One-time OpenCode instruction removal and immutable recorded identities.
  [
    /^apps\/server\/src\/orchestration-v2\/(?:Adapters\/OpenCode2AdapterV2\.test|OpenCode2OrchestratorV2\.integration\.test)\.ts$/,
    /out\("session.instructions.entry.remove", \{ sessionID: (?:SESSION|OTHER), key: "rove" \}\)|DELETE rove/g,
  ],
  [/^apps\/server\/src\/textGeneration\/OpenCode2TextGeneration\.fixture\.ts$/, /Rove Code/g],
  [/^apps\/server\/scripts\/codexReplayRecordingRecords\.ts$/, /\/home\/replay-user\/rove/g],
  [
    /^apps\/server\/src\/orchestration-v2\/testkit\/fixtures\/claude_local_bash_task\/output\.ts$/,
    /@rove-code\/web/g,
  ],
  // Integration tests of migration, retirement, or rejection. Only the known
  // historical tokens are allowed; public origins and release names still fail.
  [
    /\.test\.(?:ts|tsx|mjs|cjs)$/,
    /\.rove-code|rove-composer-attachments|rove-client\.db|rove\.cloud\.relay-access-tokens|persist:rove-preview-[a-f0-9]+|rove-v2|Rove Code Beta|refs\/rove\/|rove\.service|\b(?:VITE_)?ROVE_[A-Z_]+\b/g,
  ],
  [/^apps\/desktop\/src\/app\/DesktopAppIdentity\.test\.ts$/, /rove-code/g],
  [/^apps\/server\/src\/vcs\/GitVcsDriver\.test\.ts$/, /user\.name=Rove Code/g],
  [/^apps\/server\/scripts\/paperplane-sqlite-state\.test\.ts$/, /Rove Code/g],
  [
    /^apps\/server\/src\/auth\/(?:EnvironmentAuth|http)\.test\.ts$/,
    /rove_session|rove_dev_session_|rove_/g,
  ],
  [
    /^packages\/shared\/src\/paperplaneMcpToolPresentation\.test\.ts$/,
    /mcp__(?:rove|rove-code|rove_code)__delegate_task|rove\.delegate_task|rove-code_delegate_task|rove_code\/delegate_task|rove-thread_old_delegate_task|(?:mcp__paperplane__)?rove_thread_read/g,
  ],
  [/^apps\/server\/src\/mcp\/toolkits\/core\.test\.ts$/, /"rove_"/g],
  [/^apps\/web\/src\/components\/files\/projectFilesQueryState\.test\.tsx$/, /rove\.json/g],
  [/^apps\/mobile\/src\/persistence\/mobile-database\.test\.ts$/, /rove-thread:|"rove"/g],
  [
    /^(?:packages\/shared\/src\/providerAuthReturnUrl|apps\/web\/src\/hostedPairing)\.test\.ts$/,
    /https:\/\/rove(?:-nightly)?\.hafiezulzikry\.com\/(?:welcome)?/g,
  ],
  [/^\.gitignore$/, /^\.rove$/gm],
];

function isExemptFile(file) {
  const migration =
    /^infra\/relay\/migrations\/postgres\/([^/]+)\/(?:migration\.sql|snapshot\.json)$/.exec(file);
  return (
    file.startsWith(".repos/") ||
    file.startsWith("patches/") ||
    /^apps\/server\/src\/orchestration-v2\/testkit\/fixtures\/.+\.ndjson$/.test(file) ||
    migrationUnits.has(file) ||
    (migration !== null && historicalRelayMigrations.has(migration[1])) ||
    file === "scripts/check-release-identity.mjs" ||
    file === "scripts/check-release-identity.test.mjs"
  );
}

function withoutAllowedHistory(file, source) {
  let remaining = source.replace(/data:[^\s"']+;base64,[A-Za-z0-9+/=]+/g, "");
  if (historicalDocs.has(file)) {
    remaining = remaining.replace(
      /Rove Code|~\/\.rove(?:-code)?|\.rove\/vcs\.json|rove\.json|(?:io\.github\.hafiezul\.)?rove\.service|@rove-code\/cli|CURSOR_ROVE_[A-Z_]+|\bROVE_[A-Z_]+\b/g,
      "",
    );
  }
  if (/^docs\/adr\/000[234]-/.test(file)) {
    remaining = remaining.replace(
      /000[34]-pi-(?:subagents-are-rove-owned|delegates-through-rove-mcp)\.md/g,
      "",
    );
  }
  for (const [pathPattern, tokens] of retainedIdentities) {
    if (pathPattern.test(file)) remaining = remaining.replace(tokens, "");
  }
  return remaining;
}

export function findOldNameIdentifiers(file, source) {
  if (isExemptFile(file)) return [];
  const findings = [];
  oldIdentity.lastIndex = 0;
  if (oldIdentity.test(withoutAllowedHistory(file, file))) {
    findings.push({ file, line: 0, text: "old-name file path" });
  }
  for (const [index, text] of source.split(/\r?\n/).entries()) {
    oldIdentity.lastIndex = 0;
    if (oldIdentity.test(withoutAllowedHistory(file, text))) {
      findings.push({ file, line: index + 1, text: text.trim() });
    }
  }
  return findings;
}

function repositoryFiles(root) {
  return NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  )
    .split("\0")
    .filter(Boolean);
}

export function checkReleaseIdentity(
  root = repoRoot,
  env = process.env,
  files = repositoryFiles(root),
) {
  const blocked = [];
  const stray = files.flatMap((file) => {
    if (isExemptFile(file)) return [];
    const absolute = NodePath.join(root, file);
    // Do not follow symlinks into local credentials or developer state.
    if (!NodeFS.existsSync(absolute) || !NodeFS.lstatSync(absolute).isFile()) return [];
    const content = NodeFS.readFileSync(absolute);
    if (content.includes(0)) return [];
    return findOldNameIdentifiers(file, content.toString("utf8"));
  });
  for (const finding of stray) {
    console.error(`  ${finding.file}:${finding.line}: ${finding.text}`);
  }
  console.log(`Repository identity: ${stray.length} stray old-name identifiers.`);
  if (stray.length > 0) blocked.push("repository identity");
  for (const surface of surfaces) {
    const findings = surface.paths.flatMap((entry) =>
      sourceFiles(root, entry).flatMap((file) =>
        findUpstreamPublicIdentity(NodeFS.readFileSync(NodePath.join(root, file), "utf8")).map(
          (finding) => ({
            file: NodePath.relative(root, NodePath.join(root, file)),
            ...finding,
          }),
        ),
      ),
    );
    if (findings.length === 0) continue;
    const enabled = env[surface.readiness] === "true";
    console.log(`${surface.name} (${enabled ? "BLOCKED" : `gated by ${surface.readiness}`}):`);
    for (const finding of findings) {
      console.log(`  ${finding.file}:${finding.line}: ${finding.text}`);
    }
    if (enabled) blocked.push(surface.name);
  }
  if (blocked.length > 0) {
    console.error(
      `Refusing publication for: ${blocked.join(", ")}. Replace stray identities or remove upstream claims first.`,
    );
  }
  return blocked.length === 0;
}

if (
  process.argv[1] &&
  NodePath.resolve(process.argv[1]) === NodeURL.fileURLToPath(import.meta.url)
) {
  process.exitCode = checkReleaseIdentity() ? 0 : 1;
}
