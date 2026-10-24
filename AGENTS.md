# Paperplane

Paperplane is a minimal GUI for coding agents. A Node WebSocket server wraps provider runtimes (Codex, Claude Code, Cursor, Grok, OpenCode, Antigravity, Muse, Pi) and serves web, desktop, and mobile clients.

It is a "bring-your-own-subscription" alternative to apps like Claude Desktop, Codex App, Cursor Glass, and Conductor.

Paperplane is a fork of [T3 Code](https://github.com/pingdotgg/t3code) (`upstream` remote) with its own repo (`hafiezul/rove`), releases, and roadmap. We still sync upstream changes, so keep fork-specific changes easy to identify and preserve upstream attribution.

## What we never compromise on

### 1. Open at the core

All code, the roadmap, and our reasoning are public. Many users run forks, including us. Do not make the fork harder to fork.

### 2. Performance

We regularly audit for performance regressions. Common causes are sending too much data over WebSockets, CSS animations that spike the GPU, and lists that are expensive to render. Consider the performance cost of every change.

### 3. Remote ready

The WebSocket layer (`npx @getpaperplane/cli`) supports direct connections over the local network, including pairing, Tailscale, and SSH. Paperplane Connect, our tunnel solution in `infra/relay`, ships only when `PAPERPLANE_CLOUD_READY` is set. It is off for current releases and fresh clones, so the gating that hides it must keep working.

### 4. Multi-surface

Paperplane has three app surfaces: **web**, **desktop**, and **mobile**.

- **Web** has two forms: the hosted app at `rove.hafiezulzikry.com` (static Cloudflare deploy, no backend, users pair their own hosts) and the copy each CLI host serves locally. New features should support both where reasonable.
- **Desktop** is the main surface. Electron bundles the server and can act as the host for LAN, Tailscale, or SSH clients. Builds publish to GitHub Releases on stable and daily nightly channels. macOS builds are self-signed, not notarized.
- **Mobile** is React Native for iOS and Android. It is source-only: build the dev client and pair it over the network. There are no store releases yet.

## Design principles

Prefer ambitious ideas, simple systems, and software that feels obvious. Do not keep complexity just because it already exists. Do not add machinery because it looks architecturally impressive. Understand the real constraint, then find the smallest model that makes the correct behavior unsurprising.

Measure twice, cut once, and remember YAGNI. Fight scope creep. Honor the developer's intent in a minimal, realistic way.

Treat the rest of this document as good defaults rather than hard rules. The developer's preferences override anything here.

Most contributions are made through Paperplane itself, often remotely. Be careful when accessing data, killing dev servers, or doing anything else that could damage the Paperplane instance the contributor is using.

## Glossary

- **you** means the agent reading this file and changing Paperplane.
- **we, us, and maintainers** mean the people building this fork. These are who you are talking to.
- **upstream** means T3 Code (`pingdotgg/t3code`), the project Paperplane forked from.
- **user** means the person using Paperplane to direct coding agents.
- **agent** means the coding agent a user runs inside Paperplane. Depending on context, that may also include you.
- **provider** means the agent runtime Paperplane talks to: Codex, Claude, Cursor, Grok, OpenCode, Antigravity, Muse, or Pi. Most run as subprocesses. Pi runs in-process through its SDK (see [ADR 0001](docs/adr/0001-pi-provider-uses-sdk-in-process.md)).
- **client** means the web, desktop, or mobile UI.
- **environment** means one running Paperplane server and the machine, filesystem, provider credentials, and state it owns.
- **project** means an environment-local workspace record rooted at a directory.
- **thread** means the durable conversation and work history.
- **turn** means one user-to-agent cycle, including follow-up work such as checkpointing.
- **Paperplane home** means the base data directory, `~/.paperplane` by default. Runtime state lives in its `userdata` directory. A linked worktree's gitignored `.paperplane` directory is separate dev state, not the Paperplane home.

Provider-integration terms (driver, thread memory, sterile Pi, fork-as-rollback) are defined in [`CONTEXT.md`](CONTEXT.md). The full glossary with file links is in [`docs/internals/glossary.md`](docs/internals/glossary.md).

## Three ways to hurt yourself

1. **Killing by pattern.** Never use `pkill -f` or `pgrep | kill`, and never `kill` a PID you found by matching a name, path, or worktree string. Your own agent process has this worktree's path in its argv, and this machine runs several other dev servers. Kill only a PID you captured at spawn, or the process that owns your port after confirming its working directory is your worktree. On Linux, find that owner with `ss -H -ltnp` and `/proc/<pid>/cwd`. On macOS, use `lsof -nP -iTCP:<port> -sTCP:LISTEN` and `lsof -a -p <pid> -d cwd`.
2. **Writing to the live install.** `~/.paperplane/userdata` is the developer's real Paperplane database, in use while you work. You may read and copy it (see [Test data](#test-data)). Never start a server against it, open it read-write, or clean it up.
3. **Baking in origins.** Never set `VITE_HTTP_URL` or `VITE_WS_URL` for dev. Dev is single-origin, and Vite proxies `/api`, `/ws`, `/oauth`, and `/.well-known`. Setting these variables bakes localhost into the bundle and silently breaks every remote browser.

## Hit every surface

The most common defect in this repo is a change that works on the tested path and is missing everywhere else. Before calling frontend work done, walk this list and say which entries applied:

- **Entry points.** A behavior reachable from the chat view is usually also reachable from Settings, the command palette, and a keybinding. Fixing one is not fixing the feature.
- **Clients.** Web, desktop (wraps web and adds the Electron shell and IPC), and mobile (React Native with separate navigation). Shared logic lives in `packages/client-runtime`.
- **Providers.** Codex, Claude, Cursor, Grok, OpenCode, Antigravity, Muse, and Pi each have an adapter. Shared provider implementations live in `packages/provider-*`; Paperplane's in-process Pi implementation stays in `apps/server/src/provider`. Provider-shaped features need a decision for each adapter, even if the decision is "not supported here".
- **Agents.** A capability a user can trigger is usually one an agent should reach through MCP tools, and scheduled tasks run the same paths. That only works when it is a service method, not handler code.
- **Contracts.** Anything crossing the wire is typed in `packages/contracts`. When the schema changes, update the server, web, mobile, and desktop to match.
- **Reverse states.** If you add a way in, add a way out and a way to see it. Snooze needs unsnooze. Close needs reopen. A one-way door is a bug.
- **Connection modes.** Local, LAN, Tailscale, SSH, the hosted web app, and Paperplane Connect (when enabled) behave differently. Multi-device and multi-environment cases are real.
- **Docs.** Check whether the change makes existing guidance inaccurate. Apply the [documentation rules](#documentation) before adding anything.

## Dev servers

- `vp i` installs dependencies. Worktrees get this from the `paperplane.json` setup script; if module resolution looks broken, it probably did not run.
- `vp run dev` starts the server and web client. `vp run dev:desktop` starts Electron.
- In a linked worktree, state defaults to the worktree's gitignored `.paperplane`. This deliberately outranks an ambient `PAPERPLANE_HOME`, so you cannot land on shared state by accident. The main checkout defaults to `~/.paperplane/dev`. An explicit `--home-dir` always wins.
- Ports derive from the worktree path and stay stable across restarts. Occupied ports can shift them, so read the real ports from the `[dev-runner]` line.
- To share over the tailnet, run `vp run dev --share` in the background, wait for the `pairingUrl:` line, and give that full URL to an unpaired browser. Do not wire up `tailscale serve` by hand, open the URL yourself, or consume the user's pairing link. A browser with the reusable dev cookie can use the bare origin. If a one-time token was consumed, mint a new one with `node apps/server/src/bin.ts pair`. That token has standard scopes. The startup URL has the admin scopes needed for Connections settings.
- To reuse web dev auth across worktrees, set one fixed `PAPERPLANE_DEV_AUTH_TOKEN` in the main checkout's gitignored `.env`. The `paperplane.json` setup links that file into worktrees. Never commit or publish the token or a startup URL. See [Reusable dev credential](docs/operations/development.md#reusable-dev-credential).
- Stop only the processes you started, using the PIDs you tracked. See rule 1.

## Test data

An empty database is a bad test. Seed your worktree's `.paperplane` with a copy of real data instead of pointing at live state:

- Run `vp run migrate-dev-db` with your dev server stopped. It rebuilds `<worktree>/.paperplane/userdata/statev2.sqlite` from a read-only snapshot of `~/.paperplane/userdata/statev2.sqlite`, the developer's real data. It keeps recent projects and their stopped threads, and drops scheduled tasks, pending work, and auth sessions, so your dev server never runs the developer's agents. Raise `--projects` and `--threads-per-project` for more data.
- Refresh `statev2.sqlite`, not `state.sqlite`. The server copies the V1 `state.sqlite` only when `statev2.sqlite` is missing.
- Bring `secrets` and `settings.json` only if the flow under test needs them.
- Copy in, never symlink. Data flows one way: into your sandbox, never back out.

## Verifying

- Use the smallest proof that the change works. Run `vp test run <files>` for the tests you touched, plus targeted lint and typecheck for the changed scope.
- Test meaningful logic or observable behavior. Do not render components to static markup to assert props or attributes, and do not add tests that only check callback wiring or mirror the implementation.
- **Do not run repo-wide checks.** Do not run `vp check`, `vp run -r test`, or `vp run -r typecheck` unless asked. CI owns the full suite.
- Ship backend behavior changes with focused tests for that behavior.
- The server is event-sourced, and side effects run after the command commits. In tests, drain the effect worker (`OrchestrationEffectWorkerV2.drain`) or await the specific persisted event or `Deferred` that marks the milestone. Never wait on sleeps or polling. A test that needs a timeout to pass is wrong.
- When asked, give user-visible frontend changes one integrated pass in a real client: use `test-paperplane-app` for web and `test-paperplane-mobile` for mobile (skills in `.agents/skills`). The primary agent does this once after integrating. Subagents do not launch their own dev servers. Ask permission before using computer use or opening browsers.

For authorized mobile verification, a missing or outdated native client is a build step, not a blocker. Run `node scripts/mobile-native-client.ts ensure <ios|android> <device-id>` on the simulator host before starting Metro. It checks the local Expo fingerprint and builds or installs when needed. See `test-paperplane-mobile` for the full workflow.

## Upstream

- Before fixing something, check whether upstream already fixed it. Port the upstream fix when it fits.
- Upstream syncs are their own PRs (`chore: sync upstream updates ...`). Preserve Paperplane branding, `@getpaperplane/*` names, `~/.paperplane` paths, and fork-only features such as the Pi provider when resolving conflicts.
- Saved-data, protocol, and native-module identifiers need explicit migrations, not bulk renames. See [Releasing](docs/operations/release.md).

## Pull requests

- Never make a PR unless the developer explicitly asks for one.
- Open PRs against `hafiezul/rove`, never upstream, unless asked.
- Use conventional commit titles in plain language, for example `fix(web): new threads no longer spike CPU`.
- In the body, state the problem in a sentence or two, then explain the fix. End with the model and harness that did the work.
- UI changes need before and after images. Motion or timing changes need a short video.
- Upload PR evidence to GitHub. Never commit PR-only screenshots or assets such as `.github/pr-assets/`.
- Keep one concern per PR. If the description says "also", split it.
- When babysitting, poll checks and comments newer than the last push. Verify each bot finding against the source, fix real issues, and dismiss false positives with a written reason. Stay quiet when nothing is new. Stop when the bots are green on the latest commit.

## Releases

`release.yml` publishes a nightly every day at 00:00 UTC when there are new commits, plus manual stable and preview builds. It publishes desktop installers to GitHub Releases, `@getpaperplane/cli` to npm, and the hosted web app to Cloudflare. Each channel has its own `PAPERPLANE_*_READY` gate. Do not flip a gate to work around a failing check. Details are in [docs/operations/release.md](docs/operations/release.md).

## Documentation

Most code changes do not need an internal documentation change. Agents can read the code.

- `docs/internals/` is for architectural decisions and their reasons, constraints that span components, and implementation traps that are hard to discover from the source. Before adding a paragraph, ask what a maintainer would get wrong without it. If reading the relevant code answers the question, leave it out.
- `docs/adr/` records significant decisions, one per file, numbered.
- Do not document every feature, enumerate fields or methods, narrate control flow, maintain file catalogs, or append PR summaries. Types, tests, and code already record the implementation. The glossary defines shared vocabulary; it is not a feature index.
- Put local implementation explanations in nearby code comments. Use an internal doc when the reasoning crosses boundaries or needs context the code cannot carry well. Link to the relevant source instead of copying it.
- When a documented decision or constraint changes, rewrite or remove the affected text. Do not append another account of the new behavior. A new internal page needs a distinct, durable reason to exist.
- `docs/user/` helps users accomplish tasks. Give each major feature a concise section explaining what it does, how to start, and anything unintuitive. A settings path is useful; descriptions of visible buttons, icons, layouts, animations, or every UI state are not. Before adding text, ask what task or decision it helps the user with.
- Write user docs in the shipped product's voice, without implementation details or contributor tooling. Update the relevant feature section when how to use it changes. A UI tweak does not need a documentation entry, and a new control does not need its own page.
- `docs/operations/` holds maintainer setup, release, deployment, and debugging procedures. Keep instructions for operating an installed Paperplane server in the user guides.

## Plans and work artifacts

- Do not commit implementation plans, research notes, or agent scratch files. Keep temporary working material outside the worktree. `.plans/` is gitignored only as a safety net for legacy tooling.
- Track active work in the GitHub issue that owns it on `hafiezul/rove`.
- A merged PR is the implementation record. Close or update its tracking issue when the work lands; do not keep a second checklist in the repository.

## How it works

Clients send typed WebSocket requests. The server turns them into _commands_. The _orchestrator_ (`apps/server/src/orchestration-v2/Orchestrator.ts`) serializes commands and decides _events_ without doing I/O. The _event sink_ commits events, read-model projections, the command receipt, and outbox effects in one transaction. The _effect worker_ then runs effects, such as starting a provider turn or capturing a checkpoint, and feeds results back as commands. Provider _adapters_ translate native protocols into orchestration events. Most providers run as subprocesses; Paperplane's Pi provider uses its in-process SDK. Each turn ends with a _checkpoint_, a hidden git ref that lets the app diff and restore.

Architecture and constraints: [`docs/internals/overview.md`](docs/internals/overview.md). Glossary: [`docs/internals/glossary.md`](docs/internals/glossary.md).

## Where code lives

- `apps/server` - WebSocket server, orchestration, providers, checkpointing, and the `paperplane` CLI. Effect-heavy: read [Effect services](docs/internals/effect-services.md) before adding server code, and `.repos/effect-smol/LLMS.md` for the Effect library itself.
- `apps/web` - React/Vite UI. `apps/desktop` wraps it in Electron, `apps/mobile` is React Native, and `apps/marketing` is the landing page.
- `packages/contracts` - Effect/Schema contracts and small derived helpers. No heavy runtime logic.
- `packages/shared` - shared runtime utilities with subpath exports and no barrel.
- `packages/client-runtime` - client code shared by web and mobile.
- `packages/ssh`, `packages/tailscale` - remote connection helpers.
- `packages/provider-*` - shared provider adapters and runtime protocols. Paperplane's Pi runtime remains SDK-based, not upstream's RPC provider.
- `packages/effect-acp`, `packages/effect-codex-app-server` - Effect bindings for provider protocols.
- `infra/relay` - Paperplane Connect relay, gated by `PAPERPLANE_CLOUD_READY`.
- `native/` - native helpers (resource monitor, terminal VT, Linux SnapShot, browser secrets).
- `.agents/skills/` - repo skills for testing web, mobile, and iOS.
- `.repos/` - vendored read-only references. Prefer their patterns over invented ones. Never edit or import from them. Run `vpr sync:repos` when bumping the matching dependency.

## Taste

- Complexity belongs at the adapter boundary. Orchestration stays pure, and UI stays dumb.
- Client mutations use `createEnvironmentRpcCommand`. Add protected methods to `CLIENT_GUARDED_RPC_SCOPES` in contracts and use the command's `permissionAtom` for UI availability. Grants are checked at execution against the destination environment; the server remains authoritative. Keep raw RPC clients inside `rpc/`, and extend the permission behavior tests when adding a protected method.
- Server features are services; transports stay thin. A `ws.ts` RPC handler, HTTP route, or MCP tool decodes input, calls one service method, and maps errors. See [Effect services](docs/internals/effect-services.md).
- `apps/web/src/components/ui` exports own their look. Choose a `variant` or `size`; do not restyle one with `className`. If none fits and the look is generic, add a variant to the component. A look that belongs to one feature stays in that feature's component, not in `components/ui`. Layout classes such as width, flex, margin, and position belong on the parent. `shadcn/no-restyle` fails lint on violations.
- Prefer inferred types over annotations. `any` is the enemy.
- Comments describe how code is used and move when the code moves. Use them mostly for functions, not to annotate every line of behavior.
- Users drive agents all day and notice dropped frames, lying spinners, and stale labels. Do not use continuously repainting animations; they peg the GPU on high-refresh displays.
- If a rule here conflicts with the task, say so clearly and get human sign-off before breaking it.

## Additional tips

- Do not verify with browsers or computer use unless the user explicitly agrees or requests it.
- Security matters, but do not overindex on it, especially for dev-mode or maintainer-only features.
