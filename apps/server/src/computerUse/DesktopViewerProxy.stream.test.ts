// @effect-diagnostics nodeBuiltinImport:off -- Exercise the real WebSocket-to-RFB transport with test-owned loopback sockets and child processes.
import * as Net from "node:net";
import { expect, it } from "@effect/vitest";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { AuthOrchestrationOperateScope, AuthSessionId, ThreadId } from "@getpaperplane/contracts";
import { Environment as HostProcessEnvironment } from "@getpaperplane/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServer } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as CuaDriver from "./CuaDriver.ts";
import * as ComputerDesktops from "./ComputerDesktops.ts";
import * as DesktopViewerProxy from "./DesktopViewerProxy.ts";

it.effect.each(["tcp", "process"] as const)(
  "bridges binary RFB over %s and closes live sockets when the desktop is revoked",
  (kind) =>
    Effect.gen(function* () {
      const upstreamClosed = Promise.withResolvers<void>();
      const sockets = new Set<Net.Socket>();
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          Net.createServer((socket) => {
            sockets.add(socket);
            socket.on("error", () => {});
            socket.on("close", () => {
              sockets.delete(socket);
              upstreamClosed.resolve();
            });
            socket.write(Uint8Array.of(0x80, 0xff));
            socket.pipe(socket);
          }),
        ),
        (server) =>
          Effect.promise(
            () =>
              new Promise<void>((resolve) => {
                for (const socket of sockets) socket.destroy();
                server.close(() => resolve());
              }),
          ),
      );
      yield* Effect.promise(
        () => new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)),
      );
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing RFB port");
      const registry = yield* ComputerDesktops.make;
      yield* registry.setMode("isolated");
      const endpoint: ComputerDesktops.DesktopEndpoint =
        kind === "tcp"
          ? { kind, host: "127.0.0.1", port: address.port, password: "not-in-state" }
          : {
              kind,
              password: null,
              transport: {
                command: process.execPath,
                args: [
                  "-e",
                  "process.stdout.write(Buffer.from([0x80,0xff]));process.stdin.pipe(process.stdout)",
                ],
              },
            };
      yield* registry.register(
        "desktop",
        {
          kind: "linux",
          role: "thread",
          threadId: ThreadId.make("test"),
          name: "Test desktop",
        },
        Effect.succeed(endpoint),
      );
      const state = Option.getOrThrow(yield* Stream.runHead(registry.changes));
      expect(JSON.stringify(state)).not.toContain("not-in-state");
      const id = state.desktops[0]!.id;
      const services = yield* Layer.build(
        HttpRouter.serve(DesktopViewerProxy.layer, { disableListenLog: true }).pipe(
          Layer.provideMerge(NodeHttpServer.layerTest),
          Layer.provide(
            Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
              authenticateWebSocketUpgrade: () =>
                Effect.succeed({
                  sessionId: AuthSessionId.make("test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes: [AuthOrchestrationOperateScope],
                }),
            } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
          ),
          Layer.provide(
            Layer.succeed(CuaDriver.CuaDriver, {
              desktopConnection: registry.connection,
            } as unknown as CuaDriver.CuaDriver["Service"]),
          ),
          Layer.provide(Layer.succeed(HostProcessEnvironment, process.env)),
        ),
      );
      const origin = HttpServer.formatAddress(
        Context.get(services, HttpServer.HttpServer).address,
      ).replace(/^http/, "ws");
      const client = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new WebSocket(`${origin}/api/computer-use/desktops/${id}/vnc?wsTicket=test`, "binary"),
        ),
        (client) => Effect.sync(() => client.close()),
      );
      client.binaryType = "arraybuffer";
      const received = Promise.withResolvers<void>();
      const closed = Promise.withResolvers<void>();
      const frames: number[][] = [];
      client.addEventListener("error", () => received.reject(new Error("Viewer failed")));
      client.addEventListener("close", () => closed.resolve());
      client.addEventListener("message", ({ data }) => {
        frames.push(Array.from(new Uint8Array(data as ArrayBuffer)));
        if (frames.length === 1) client.send(Uint8Array.of(0, 0xff, 0x81));
        else received.resolve();
      });
      yield* Effect.promise(() => received.promise);
      expect(client.protocol).toBe("binary");
      expect(frames).toEqual([
        [0x80, 0xff],
        [0, 0xff, 0x81],
      ]);
      yield* registry.remove("desktop");
      yield* Effect.promise(() => closed.promise);
      if (kind === "tcp") yield* Effect.promise(() => upstreamClosed.promise);
      expect((yield* registry.viewer(id).pipe(Effect.flip))._tag).toBe(
        "ComputerDesktopViewerError",
      );
    }),
);
