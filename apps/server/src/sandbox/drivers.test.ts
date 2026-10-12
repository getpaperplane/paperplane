import { expect, it, vi } from "vite-plus/test";
import { makeBoatDriver, type SandboxHandle } from "./drivers.ts";

const handle: SandboxHandle = {
  remoteId: "bx_23456789",
  url: null,
  snapshotIds: [],
  volumeName: null,
  paused: false,
};
const sandbox = (state = "ready") => ({
  ok: true,
  type: "sandbox.get",
  sandbox: { id: handle.remoteId, state },
});
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

it("Boat creates no-env persistent compute with a stable idempotency key and never queues prompts", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(response(sandbox("provisioning"), 202));
  const driver = makeBoatDriver({ token: "test-key", tokenId: "" }, transport);
  expect(await driver.create("rove-thread-id")).toMatchObject({ remoteId: handle.remoteId });
  expect(transport).toHaveBeenCalledWith(
    "https://boat.dev/api/v1/sandboxes",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ type: "default", noEnv: true, ttlSeconds: null }),
      headers: expect.any(Headers),
    }),
  );
  const headers = new Headers(transport.mock.calls[0]?.[1]?.headers);
  expect(headers.get("Authorization")).toBe("Bearer test-key");
  expect(headers.get("Idempotency-Key")).toBe("rove-thread-id");
  expect(transport.mock.calls.some(([url]) => String(url).includes("prompt"))).toBe(false);
});

it("Boat pause waits for the documented archived state, not a fictional stopped receipt", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      response(
        String(url).endsWith("/stop")
          ? { ok: true, type: "sandbox.stopping" }
          : sandbox("archived"),
      ),
    );
  await makeBoatDriver({ token: "key", tokenId: "" }, transport).pause(handle, async () => {});
  expect(transport.mock.calls.map(([url]) => String(url))).toEqual([
    "https://boat.dev/api/v1/sandboxes/bx_23456789/stop",
    "https://boat.dev/api/v1/sandboxes/bx_23456789",
  ]);
});

it("Boat deletion persists its operation receipt before observing completed cleanup", async () => {
  const events: string[] = [];
  const transport = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    events.push(init?.method ?? "GET");
    return response(
      {
        ok: true,
        operation: {
          id: "bdop_one",
          status: String(url).includes("deletion-operations") ? "completed" : "pending",
        },
      },
      init?.method === "DELETE" ? 202 : 200,
    );
  });
  await makeBoatDriver({ token: "key", tokenId: "" }, transport).remove(handle, async (id) => {
    events.push(`persist:${id}`);
  });
  expect(events).toEqual(["DELETE", "persist:bdop_one", "GET"]);
  expect(new Headers(transport.mock.calls[0]?.[1]?.headers).get("X-Ascii-Confirm-Delete")).toBe(
    handle.remoteId,
  );
});

it("retrying accepted Boat deletion polls the saved receipt rather than re-deleting a hidden resource", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockResolvedValue(response({ operation: { id: "bdop_one", status: "completed" } }));
  await makeBoatDriver({ token: "key", tokenId: "" }, transport).remove(
    { ...handle, deletionOperationId: "bdop_one" },
    async () => {},
  );
  expect(transport).toHaveBeenCalledOnce();
  expect(transport.mock.calls[0]?.[1]?.method).toBe("GET");
});

it("Boat hosting is public at the proxy but remains protected by Rove authentication", async () => {
  const transport = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      response(
        String(url).endsWith("/commands")
          ? { success: true, exitCode: 0, stdout: "Hosted at https://example-7340.on.boat.dev\n" }
          : sandbox("running"),
      ),
    );
  const url = await makeBoatDriver({ token: "key", tokenId: "" }, transport).expose(handle);
  expect(url).toBe("https://example-7340.on.boat.dev");
  expect(transport.mock.calls[1]?.[1]?.body).toBe(
    JSON.stringify({ command: "host 7340 --public", timeoutSeconds: 180 }),
  );
});

it("vendor error bodies and failed command output are not surfaced to users", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(response({ error: "echoed-key" }, 401));
  const driver = makeBoatDriver({ token: "echoed-key", tokenId: "" }, transport);
  await expect(driver.create("id")).rejects.toThrow("Boat request failed (HTTP 401).");
  const failed = vi
    .fn<typeof fetch>()
    .mockImplementation(async (url) =>
      response(
        String(url).endsWith("/commands")
          ? { success: false, exitCode: 1, stdout: "secret-output" }
          : sandbox(),
      ),
    );
  await expect(
    makeBoatDriver({ token: "key", tokenId: "" }, failed).exec(handle, "false"),
  ).rejects.toThrow("Sandbox command failed. Inspect the sandbox in Boat for details.");
});
