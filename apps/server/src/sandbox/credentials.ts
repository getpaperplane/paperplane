// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { SandboxCredentialKind } from "@rove-code/contracts";
import { SandboxDriverError } from "./errors.ts";

/** A tool the sandbox needs before a forwarded sign-in is usable. */
export interface SandboxTool {
  bin: string;
  install: "npm" | "apt";
  name: string;
}
/**
 * Applied in the sandbox by `sandboxCredentialsCommand`. Paths are relative to
 * the sandbox's home. Sent over the command's stdin so secrets never appear in
 * process arguments.
 */
export interface SandboxCredentialPayload {
  files: Array<{ path: string; content: string }>;
  remove: Array<string>;
  tools: Array<SandboxTool>;
  git: { setupGh: boolean; name: string | null; email: string | null } | null;
}
export interface SandboxCredentialSource {
  /** Sign-ins present on the managing environment. Never returns secrets. */
  available: () => Promise<ReadonlyArray<SandboxCredentialKind>>;
  /** Builds the payload that leaves exactly `kinds` signed in. */
  payload: (kinds: ReadonlyArray<SandboxCredentialKind>) => Promise<SandboxCredentialPayload>;
}

const SANDBOX_CREDENTIAL_KINDS: ReadonlyArray<SandboxCredentialKind> = [
  "codex",
  "claude",
  "pi",
  "opencode",
  "github",
];
const sandboxCredentialName = {
  codex: "Codex",
  claude: "Claude",
  pi: "Pi",
  opencode: "OpenCode",
  github: "GitHub",
} satisfies Record<SandboxCredentialKind, string>;

// Where each sign-in lives inside the sandbox (Linux defaults for each CLI).
const SANDBOX_PATHS = {
  codex: ".codex/auth.json",
  claude: ".claude/.credentials.json",
  pi: ".pi/agent/auth.json",
  opencode: ".local/share/opencode/auth.json",
  github: ".config/gh/hosts.yml",
} satisfies Record<SandboxCredentialKind, string>;
const TOOLS: Partial<Record<SandboxCredentialKind, SandboxTool>> = {
  codex: { bin: "codex", install: "npm", name: "@openai/codex" },
  claude: { bin: "claude", install: "npm", name: "@anthropic-ai/claude-code" },
  opencode: { bin: "opencode", install: "npm", name: "opencode-ai" },
  github: { bin: "gh", install: "apt", name: "gh" },
};
const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

const run = (command: string, args: ReadonlyArray<string>) =>
  new Promise<string | null>((resolve) => {
    NodeChildProcess.execFile(command, args, { timeout: 10_000 }, (error, stdout) =>
      resolve(error ? null : stdout.trim()),
    );
  });
const isFile = (path: string) =>
  NodeFSP.stat(path).then(
    (value) => value.isFile(),
    () => false,
  );

/** Reads sign-ins from the managing environment's own provider homes. */
export function makeLocalSandboxCredentials(host: {
  env: NodeJS.ProcessEnv;
  home: string;
  platform: NodeJS.Platform;
}): SandboxCredentialSource {
  const { env, home } = host;
  const join = NodePath.join;
  const localPaths = {
    codex: join(env.CODEX_HOME || join(home, ".codex"), "auth.json"),
    claude: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), ".credentials.json"),
    pi: join(env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent"), "auth.json"),
    opencode: join(env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode", "auth.json"),
  };
  // macOS Claude Code keeps its sign-in in the login keychain instead of a file.
  const claudeKeychain = (reveal: boolean) =>
    host.platform === "darwin"
      ? run("security", [
          "find-generic-password",
          "-s",
          CLAUDE_KEYCHAIN_SERVICE,
          ...(reveal ? ["-w"] : []),
        ])
      : Promise.resolve(null);
  const githubToken = async () =>
    env.GH_TOKEN || env.GITHUB_TOKEN || (await run("gh", ["auth", "token", "-h", "github.com"]));
  const has = async (kind: SandboxCredentialKind) => {
    if (kind === "github") return Boolean(await githubToken());
    if (await isFile(localPaths[kind])) return true;
    return kind === "claude" && (await claudeKeychain(false)) !== null;
  };
  const content = async (kind: Exclude<SandboxCredentialKind, "github">) => {
    const fromFile = await NodeFSP.readFile(localPaths[kind], "utf8").catch(() => null);
    const value = fromFile ?? (kind === "claude" ? await claudeKeychain(true) : null);
    if (!value)
      throw new SandboxDriverError(
        `${sandboxCredentialName[kind]} isn't signed in on the managing environment. Sign in there, then forward it again.`,
      );
    return value;
  };
  return {
    available: async () => {
      const found = await Promise.all(SANDBOX_CREDENTIAL_KINDS.map(has));
      return SANDBOX_CREDENTIAL_KINDS.filter((_, index) => found[index]);
    },
    payload: async (kinds) => {
      const payload: SandboxCredentialPayload = { files: [], remove: [], tools: [], git: null };
      for (const kind of SANDBOX_CREDENTIAL_KINDS) {
        if (!kinds.includes(kind)) {
          payload.remove.push(SANDBOX_PATHS[kind]);
          continue;
        }
        const tool = TOOLS[kind];
        if (tool) payload.tools.push(tool);
        if (kind !== "github") {
          payload.files.push({ path: SANDBOX_PATHS[kind], content: await content(kind) });
          continue;
        }
        const token = await githubToken();
        if (!token)
          throw new SandboxDriverError(
            "GitHub isn't signed in on the managing environment. Run gh auth login there, then forward it again.",
          );
        // A single-line token can't break out of the YAML value.
        if (/\s/.test(token))
          throw new SandboxDriverError("The GitHub token has an invalid format.");
        payload.files.push({
          path: SANDBOX_PATHS.github,
          content: `github.com:\n    oauth_token: ${token}\n    git_protocol: https\n`,
        });
        payload.git = {
          setupGh: true,
          name: await run("git", ["config", "--global", "user.name"]),
          email: await run("git", ["config", "--global", "user.email"]),
        };
      }
      return payload;
    },
  };
}
