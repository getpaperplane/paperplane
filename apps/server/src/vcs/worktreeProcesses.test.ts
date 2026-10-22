import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { Platform as HostProcessPlatform } from "@rove-code/shared/HostProcess";
import { it } from "@effect/vitest";
import { expect, vi } from "vite-plus/test";
import {
  isCwdInside,
  isServerOwnedCgroup,
  stopWorktreeProcesses,
  worktreeProcessRoots,
} from "./worktreeProcesses.ts";

it("matches deleted worktree directories without matching sibling paths", () => {
  const roots = ["/w/rove-a"];
  expect(isCwdInside("/w/rove-a (deleted)", roots)).toBe(true);
  expect(isCwdInside("/w/rove-a/apps/web (deleted)", roots)).toBe(true);
  expect(isCwdInside("/w/rove-ab/apps/web", roots)).toBe(false);
  expect(isCwdInside("/w", roots)).toBe(false);
});

it("normalizes removal roots and refuses filesystem roots", () => {
  expect(worktreeProcessRoots(["/w/a/", "/w/a", "/real/a"])).toEqual(["/w/a", "/real/a"]);
  expect(worktreeProcessRoots(["/", "//", "C:\\", ""])).toEqual([]);
  expect(isCwdInside("/w/a-b", worktreeProcessRoots(["/w/a/"]))).toBe(false);
  expect(isCwdInside("/w/a/src", worktreeProcessRoots(["/w/a/"]))).toBe(true);
});

const workload =
  "/user.slice/user@1000.service/app.slice/app-rove.slice/app-rove-workloads.slice/rove-budget-x.scope";
const service = "/user.slice/user@1000.service/app.slice/rove.service";

it("fails closed for root, slices, shared services and SSH login scopes", () => {
  for (const server of [
    "/",
    "/user.slice",
    "/system.slice/sshd.service",
    "/user.slice/user@1000.service",
    "/user.slice/user-1000.slice/session-42.scope",
  ]) {
    expect(isServerOwnedCgroup(server, server)).toBe(false);
    expect(isServerOwnedCgroup(`${server}/shell`, server)).toBe(false);
    expect(isServerOwnedCgroup(service, server)).toBe(false);
    expect(isServerOwnedCgroup(workload, server)).toBe(true);
  }
});

it("recognizes dedicated Rove units and guarded workloads, not adjacent groups", () => {
  expect(isServerOwnedCgroup(service, service)).toBe(true);
  expect(isServerOwnedCgroup(`${service}/tools`, service)).toBe(true);
  expect(isServerOwnedCgroup(`${service}2`, service)).toBe(false);
  expect(
    isServerOwnedCgroup("/app.slice/rove-server.scope/tools", "/app.slice/rove-server.scope"),
  ).toBe(true);
  expect(isServerOwnedCgroup("/app.slice/tmux.scope", service)).toBe(false);
  expect(isServerOwnedCgroup(workload, service)).toBe(true);
  expect(
    isServerOwnedCgroup(
      workload.replace("app-rove-workloads.slice", "app-rove-workloads-other.slice"),
      service,
    ),
  ).toBe(false);
  expect(
    isServerOwnedCgroup(
      "/user.slice/user@1000.service/rove.slice/rove-provider.slice/rove-provider-workloads.slice/rove-budget-x.scope",
      service,
    ),
  ).toBe(true);
});

it.effect("does nothing off Linux", () =>
  stopWorktreeProcesses(["/w"]).pipe(
    Effect.tap((stopped) => Effect.sync(() => expect(stopped).toEqual([]))),
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(FileSystem.FileSystem, FileSystem.makeNoop({})),
  ),
);

// Synthetic /proc and intercepted signals: this must never scan or kill real user processes.
it.live("protects the server chain and cwd boundary even in a dedicated unit", () =>
  Effect.gen(function* () {
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0) throw new Error("exited");
      return true;
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => kill.mockRestore()));
    const parent = 900001;
    const owned = 900002;
    const sibling = 900003;
    const peer = 900004;
    const stopped = yield* stopWorktreeProcesses(["/w/checkout"]).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readDirectory: () =>
            Effect.succeed([process.pid, parent, owned, sibling, peer].map(String)),
          readLink: (path) =>
            Effect.succeed(
              path.includes(String(sibling)) ? "/w/checkout-other" : "/w/checkout (deleted)",
            ),
          readFileString: (path) =>
            Effect.succeed(
              path.endsWith("/stat")
                ? `${process.pid} (server) S ${path.includes(String(process.pid)) ? parent : 0} 0`
                : `0::${path.includes(String(peer)) ? "/user.slice/session-42.scope" : service}\n`,
            ),
        }),
      ),
    );
    expect(stopped).toEqual([owned]);
    expect(kill.mock.calls.filter(([, signal]) => signal === "SIGTERM")).toEqual([
      [owned, "SIGTERM"],
    ]);
  }).pipe(Effect.scoped),
);
