// @effect-diagnostics nodeBuiltinImport:off -- This HTTP adapter bridges authenticated WebSockets to private RFB byte streams.
import * as ChildProcess from "node:child_process";
import * as Net from "node:net";
import { Readable, Writable, Duplex } from "node:stream";
import { AuthOrchestrationOperateScope } from "@rove-code/contracts";
import { Environment as HostProcessEnvironment } from "@rove-code/shared/HostProcess";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import { authenticateMediaRequest } from "../auth/http.ts";
import * as CuaDriver from "./CuaDriver.ts";
import type { DesktopEndpoint } from "./ComputerDesktops.ts";

const socketError = (cause: unknown) =>
  new Socket.SocketError({ reason: new Socket.SocketReadError({ cause }) });

const openRfb = (endpoint: DesktopEndpoint, env: NodeJS.ProcessEnv) =>
  Socket.fromTransformStream(
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          if (endpoint.kind === "tcp") {
            const socket = Net.connect({ host: endpoint.host, port: endpoint.port });
            return {
              stream: Duplex.toWeb(socket),
              close: () => {
                socket.destroy();
              },
            };
          }
          const process = ChildProcess.spawn(
            endpoint.transport.command,
            [...endpoint.transport.args],
            {
              env,
              stdio: ["pipe", "pipe", "ignore"],
            },
          );
          // Spawn failures must error the stream, not become an unhandled EventEmitter error.
          process.on("error", (error) => process.stdout.destroy(error));
          return {
            stream: {
              readable: Readable.toWeb(process.stdout),
              writable: Writable.toWeb(process.stdin),
            },
            close: () => {
              process.stdin.destroy();
              process.stdout.destroy();
              process.kill();
            },
          };
        },
        catch: socketError,
      }),
      (resource) => Effect.sync(resource.close),
    ).pipe(Effect.map((resource) => resource.stream)),
  );

const pump = (source: Socket.Socket, sink: Socket.Writer) =>
  Effect.gen(function* () {
    const { pull } = yield* source.reader;
    while (true) {
      const frames = yield* pull;
      // noVNC's binary protocol transports bytes only; never UTF-8 reinterpret RFB.
      if (frames.some((frame) => typeof frame === "string")) return;
      yield* sink.writeAll(frames);
    }
  });

const handler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  yield* authenticateMediaRequest(AuthOrchestrationOperateScope);
  const params = yield* HttpRouter.params;
  const driver = yield* CuaDriver.CuaDriver;
  const connection = yield* driver.desktopConnection(params.id ?? "").pipe(Effect.option);
  if (connection._tag === "None") return HttpServerResponse.text("Not Found", { status: 404 });
  if (
    request.headers.upgrade?.toLowerCase() !== "websocket" ||
    request.headers["sec-websocket-protocol"]?.trim() !== "binary"
  )
    return HttpServerResponse.text("A binary WebSocket is required", { status: 426 });
  const env = yield* HostProcessEnvironment;
  // wsTicket is consumed by authenticateMediaRequest and never forwarded to RFB.
  const client = yield* request.upgrade;
  yield* Effect.scoped(
    Effect.gen(function* () {
      const writer = yield* client.writer;
      yield* Effect.raceFirst(
        connection.value.closed,
        Effect.gen(function* () {
          const endpoint = yield* connection.value.endpoint;
          const upstream = yield* openRfb(endpoint, env);
          const upstreamWriter = yield* upstream.writer;
          yield* Effect.raceFirst(pump(upstream, writer), pump(client, upstreamWriter));
        }),
      );
    }),
  ).pipe(Effect.ignoreCause);
  return HttpServerResponse.empty();
});

export const layer = HttpRouter.add("GET", "/api/computer-use/desktops/:id/vnc", handler);
