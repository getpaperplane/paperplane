import { SANDBOX_PORT } from "@rove-code/contracts";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const nodeCommand = (source: string) => `node -e ${quote(source)}`;

// Only this deployment's captured PID may be signalled. Boot identity and process
// start time also prevent a restored PID file from targeting a different process.
const identityHelpers = `
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(process.env.HOME, '.rove-sandbox');
const pidFile = path.join(root, 'server.json');
const bootId = () => fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
const ticks = pid => fs.readFileSync('/proc/' + pid + '/stat', 'utf8').split(') ')[1].split(' ')[19];
const owned = () => {
  try {
    const saved = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    return saved.bootId === bootId() && saved.ticks === ticks(saved.pid) ? saved.pid : null;
  } catch { return null; }
};
`;

export const sandboxStartCommand = `set -eu
ROOT="$HOME/.rove-sandbox"
mkdir -p "$ROOT/runtime" "$ROOT/data" "$ROOT/workspace"
if [ ! -x "$ROOT/runtime/node_modules/.bin/rove" ]; then
  npm install --prefix "$ROOT/runtime" --no-audit --no-fund @rove-code/cli@latest
fi
${nodeCommand(`${identityHelpers}
(async () => {
if (!owned()) {
  let responding = false;
  try { responding = (await fetch('http://127.0.0.1:${SANDBOX_PORT}/.well-known/rove/environment', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
  if (responding) throw new Error('A Rove server is running without a matching owned PID; restart refused');
  const log = fs.openSync(path.join(root, 'server.log'), 'a', 0o600);
  const child = require('node:child_process').spawn(path.join(root, 'runtime/node_modules/.bin/rove'),
    ['serve', '--host', '0.0.0.0', '--port', '${SANDBOX_PORT}', '--base-dir', path.join(root, 'data'), '--no-browser'],
    { cwd: path.join(root, 'workspace'), detached: true, stdio: ['ignore', log, log],
      env: { ...process.env, ROVE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: 'false', ROVE_NO_BROWSER: 'true' } });
  child.on('error', () => process.exit(1));
  fs.writeFileSync(pidFile, JSON.stringify({ pid: child.pid, bootId: bootId(), ticks: ticks(child.pid) }), { mode: 0o600 });
  fs.closeSync(log);
  child.unref();
}
})().catch(() => process.exit(1));
`)}
# Readiness is local to the VM; this never invokes a coding provider.
${nodeCommand(`
(async () => {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      const response = await fetch('http://127.0.0.1:${SANDBOX_PORT}/.well-known/rove/environment', { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Rove server did not become ready');
})().catch(() => process.exit(1));
`)}`;

export const sandboxStopCommand = nodeCommand(`${identityHelpers}
(async () => {
  const pid = owned();
  if (!pid) {
    // A missing/stale PID file must not silently snapshot a still-running DB.
    let responding = false;
    try { responding = (await fetch('http://127.0.0.1:${SANDBOX_PORT}/.well-known/rove/environment', { signal: AbortSignal.timeout(1000) })).ok; } catch {}
    if (responding) throw new Error('A Rove server is running without a matching owned PID; snapshot refused');
    return;
  }
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 60; attempt++) {
    if (!owned()) { fs.rmSync(pidFile, { force: true }); return; }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Rove server is still shutting down; snapshot refused');
})().catch(() => process.exit(1));
`);

export const sandboxPairCommand = `"$HOME/.rove-sandbox/runtime/node_modules/.bin/rove" auth pairing create --base-dir "$HOME/.rove-sandbox/data" --json`;
