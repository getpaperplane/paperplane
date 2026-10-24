import { SANDBOX_PORT } from "@getpaperplane/contracts";
import packageJson from "../../package.json" with { type: "json" };

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = (source: string) => `node -e ${quote(source)}`;

// Bootstrap scripts exit with these codes so failures can be explained without
// forwarding command output, which may contain credentials.
const SANDBOX_INSTALL_FAILED = 10;
const SANDBOX_UNOWNED_SERVER = 11;
const SANDBOX_NOT_READY = 12;
const SANDBOX_STILL_RUNNING = 13;
const SANDBOX_CREDENTIALS_FAILED = 14;
const SANDBOX_TOOLS_FAILED = 15;

// Clients recognize sandboxes by the workspace below (SANDBOX_WORKSPACE_DIR).
const ROOT = `"$HOME/.rove-sandbox"`;
const RUNTIME = `"$HOME/.rove-sandbox/runtime"`;
const WRAPPER = `"$HOME/.rove-sandbox/runtime/node_modules/.bin/paperplane"`;

// Only this deployment's captured PID may be signalled. Boot identity and process
// start time also prevent a restored PID file from targeting a different process.
const identityHelpers = `
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(process.env.HOME, '.rove-sandbox');
const pidFile = path.join(root, 'server.json');
const bootId = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const stat = pid => fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ');
const ticks = pid => stat(pid)[19];
const owned = () => {
  try {
    const saved = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    // An unreaped zombie has already exited and closed its database.
    return saved.bootId === bootId() && saved.ticks === ticks(saved.pid) && stat(saved.pid)[0] !== 'Z' ? saved.pid : null;
  } catch { return null; }
};
const responding = async () => {
  try { return (await fetch('http://127.0.0.1:${SANDBOX_PORT}/.well-known/rove/environment', { signal: AbortSignal.timeout(1000) })).ok; }
  catch { return false; }
};
`;

// The npm wrapper runs the platform binary as a child and does not forward
// signals, so the server is spawned from the platform package directly.
const resolveBinary = `require('node:path').join(require('node:path').dirname(require.resolve('@getpaperplane/cli-' + process.platform + '-' + process.arch + '/package.json', { paths: [process.env.PAPERPLANE_SANDBOX_RUNTIME_DIR] })), 'paperplane')`;

export const sandboxStartCommand = `set -u
ROOT=${ROOT}
RUNTIME=${RUNTIME}
mkdir -p "$ROOT/data" "$ROOT/workspace" "$RUNTIME" || exit ${SANDBOX_INSTALL_FAILED}
export PAPERPLANE_SANDBOX_RUNTIME_DIR="$RUNTIME"
installed() { [ -x "$(node -p ${quote(resolveBinary)} 2>/dev/null)" ] && ${WRAPPER} --version >/dev/null 2>&1; }
# A partial install must not wedge every later repair, so verify the binary.
# npm exits 0 when an optional platform package is missing (npm can take a while
# to serve freshly published binaries), so each attempt is checked by running it.
if ! installed; then
  : >"$ROOT/install.log"
  for spec in ${quote(`@getpaperplane/cli@${packageJson.version}`)} @getpaperplane/cli@latest; do
    rm -rf "$RUNTIME/node_modules" "$RUNTIME/package.json" "$RUNTIME/package-lock.json"
    npm install --prefix "$RUNTIME" --no-audit --no-fund "$spec" >>"$ROOT/install.log" 2>&1
    installed && break
  done
  installed || exit ${SANDBOX_INSTALL_FAILED}
fi
${nodeCommand(`${identityHelpers}
(async () => {
  if (owned()) return;
  if (await responding()) process.exit(${SANDBOX_UNOWNED_SERVER});
  const binary = ${resolveBinary};
  const log = fs.openSync(path.join(root, 'server.log'), 'a', 0o600);
  const child = require('node:child_process').spawn(binary,
    ['serve', '--host', '0.0.0.0', '--port', '${SANDBOX_PORT}', '--base-dir', path.join(root, 'data'), '--no-browser'],
    { cwd: path.join(root, 'workspace'), detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, PAPERPLANE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: 'false', PAPERPLANE_NO_BROWSER: 'true' } });
  child.on('error', () => process.exit(${SANDBOX_INSTALL_FAILED}));
  fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, bootId: bootId(), ticks: ticks(child.pid) }), { mode: 0o600 });
  fs.closeSync(log);
  child.unref();
})().catch(() => process.exit(${SANDBOX_NOT_READY}));
`)} || exit $?
# Readiness is local to the VM; this never invokes a coding provider.
${nodeCommand(`${identityHelpers}
(async () => {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (await responding()) return;
    if (!owned()) process.exit(${SANDBOX_NOT_READY});
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  process.exit(${SANDBOX_NOT_READY});
})().catch(() => process.exit(${SANDBOX_NOT_READY}));
`)}`;

export const sandboxStopCommand = nodeCommand(`${identityHelpers}
(async () => {
  const pid = owned();
  if (!pid) {
    // A missing/stale PID file must not silently snapshot a still-running DB.
    if (await responding()) process.exit(${SANDBOX_UNOWNED_SERVER});
    return;
  }
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!owned()) { fs.rmSync(pidFile, { force: true }); return; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  process.exit(${SANDBOX_STILL_RUNNING});
})().catch(() => process.exit(1));
`);

// Reads a SandboxCredentialPayload (see credentials.ts) from stdin. Removals run
// first so turning a sign-in off takes effect even if a tool install fails.
export const sandboxCredentialsCommand = nodeCommand(`
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const home = process.env.HOME;
const ok = (command, args) => cp.spawnSync(command, args, { stdio: 'ignore' }).status === 0;
const has = bin => ok('sh', ['-c', 'command -v "$0"', bin]);
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  let payload;
  try {
    payload = JSON.parse(input);
    for (const rel of payload.remove) fs.rmSync(path.join(home, rel), { force: true });
    for (const file of payload.files) {
      const target = path.join(home, file.path);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target + '.rove-tmp', file.content, { mode: 0o600 });
      fs.renameSync(target + '.rove-tmp', target);
    }
  } catch { process.exit(${SANDBOX_CREDENTIALS_FAILED}); }
  const npm = payload.tools.filter(tool => tool.install === 'npm' && !has(tool.bin)).map(tool => tool.name);
  if (npm.length && !ok('npm', ['install', '-g', '--no-audit', '--no-fund', ...npm])) process.exit(${SANDBOX_TOOLS_FAILED});
  const apt = payload.tools.filter(tool => tool.install === 'apt' && !has(tool.bin)).map(tool => tool.name);
  if (apt.length && !(ok('apt-get', ['update', '-qq']) && ok('apt-get', ['install', '-y', '-qq', ...apt]))) process.exit(${SANDBOX_TOOLS_FAILED});
  if (payload.git) {
    if (payload.git.setupGh && !ok('gh', ['auth', 'setup-git', '--hostname', 'github.com'])) process.exit(${SANDBOX_CREDENTIALS_FAILED});
    if (payload.git.name) ok('git', ['config', '--global', 'user.name', payload.git.name]);
    if (payload.git.email) ok('git', ['config', '--global', 'user.email', payload.git.email]);
  }
});
`);

/**
 * Names the sandbox's Paperplane environment after the sandbox: Paperplane on Linux labels
 * itself from PRETTY_HOSTNAME, otherwise every sandbox shows its vendor hostname.
 * Read at startup, so run it before Paperplane starts. Best effort; needs root.
 */
export const sandboxLabelCommand = (label: string) =>
  `printf 'PRETTY_HOSTNAME=%s\\n' ${quote(label.replace(/[\r\n]+/g, " "))} > /etc/machine-info 2>/dev/null || true`;

export const sandboxPairCommand = `${WRAPPER} auth pairing create --base-dir "$HOME/.rove-sandbox/data" --json`;

/** Product-owned explanations for bootstrap exit codes. */
export function sandboxCommandFailure(exitCode: number): string | undefined {
  switch (exitCode) {
    case SANDBOX_INSTALL_FAILED:
      return "Could not install Paperplane in the sandbox. Check its network access, then resume to retry. The install log is at ~/.rove-sandbox/install.log in the sandbox.";
    case SANDBOX_UNOWNED_SERVER:
      return "Another Paperplane server is using the sandbox's port without a matching process record. Stop it from the vendor dashboard, then resume.";
    case SANDBOX_NOT_READY:
      return "Paperplane started in the sandbox but did not become ready. Resume to retry. The server log is at ~/.rove-sandbox/server.log in the sandbox.";
    case SANDBOX_STILL_RUNNING:
      return "Paperplane is still shutting down in the sandbox. Pause was refused to protect its data; try again shortly.";
    case SANDBOX_CREDENTIALS_FAILED:
      return "Could not save the forwarded sign-ins in the sandbox. Try forwarding them again.";
    case SANDBOX_TOOLS_FAILED:
      return "Could not install the coding tools for the forwarded sign-ins. Check the sandbox's network access, then try again.";
    default:
      return undefined;
  }
}
