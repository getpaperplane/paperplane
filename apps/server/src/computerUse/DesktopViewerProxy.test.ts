import { afterEach, describe, expect, it } from "vite-plus/test";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  AuthSessionId,
  ComputerDesktopViewerError,
  type AuthEnvironmentScope,
} from "@getpaperplane/contracts";
import { Environment as HostProcessEnvironment } from "@getpaperplane/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as CuaDriver from "./CuaDriver.ts";
import * as DesktopViewerProxy from "./DesktopViewerProxy.ts";

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

const fixture = (
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  authError?: EnvironmentAuth.ServerAuthCredentialError | EnvironmentAuth.ServerAuthInternalError,
) => {
  const lookups: string[] = [];
  const { handler, dispose } = HttpRouter.toWebHandler(
    DesktopViewerProxy.layer.pipe(
      Layer.provideMerge(
        Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
          authenticateWebSocketUpgrade: () =>
            authError
              ? Effect.fail(authError)
              : Effect.succeed({
                  sessionId: AuthSessionId.make("test"),
                  subject: "test",
                  method: "bearer-access-token",
                  scopes,
                }),
        } as unknown as EnvironmentAuth.EnvironmentAuth["Service"]),
      ),
      Layer.provideMerge(
        Layer.succeed(CuaDriver.CuaDriver, {
          desktopConnection: (id: string) =>
            Effect.suspend(() => {
              lookups.push(id);
              return Effect.fail(new ComputerDesktopViewerError({ desktopId: id }));
            }),
        } as unknown as CuaDriver.CuaDriver["Service"]),
      ),
      Layer.provideMerge(Layer.succeed(HostProcessEnvironment, {})),
    ),
    { disableLogger: true },
  );
  disposers.push(dispose);
  return { handler, lookups };
};
const request = () =>
  new Request("http://paperplane.test/api/computer-use/desktops/unknown/vnc?wsTicket=secret", {
    headers: { upgrade: "websocket", "sec-websocket-protocol": "binary" },
  });

describe("private desktop viewer proxy", () => {
  it("requires operate scope even to watch an interactive desktop", async () => {
    const { handler, lookups } = fixture([AuthOrchestrationReadScope]);
    expect((await handler(request())).status).toBe(403);
    expect(lookups).toEqual([]);
  });
  it("refuses unknown desktop IDs before upgrading", async () => {
    const { handler, lookups } = fixture([AuthOrchestrationOperateScope]);
    const response = await handler(request());
    expect(response.status).toBe(404);
    expect(lookups).toEqual(["unknown"]);
    expect(await response.text()).not.toContain("secret");
  });
  it.each([
    [new EnvironmentAuth.ServerAuthMissingCredentialError({}), 401],
    [
      new EnvironmentAuth.ServerAuthSessionCredentialValidationError({
        cause: new Error("private diagnostic"),
      }),
      500,
    ],
  ] as const)("maps auth failures without leaking credentials", async (error, status) => {
    const { handler, lookups } = fixture([], error);
    const response = await handler(request());
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain("private diagnostic");
    expect(lookups).toEqual([]);
  });
});
