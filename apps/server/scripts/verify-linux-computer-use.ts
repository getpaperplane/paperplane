/**
 * Opt-in smoke test for a disposable Linux host. --run installs system packages
 * through the real Computer Use service, downloads Cua Driver, and builds/starts
 * private desktops. Never run it against a contributor's live environment.
 *
 * Bundle outside the checkout with:
 * vp pack apps/server/scripts/verify-linux-computer-use.ts --no-config \
 *   --platform node --deps.always-bundle '*' --out-dir /tmp/paperplane-cua-smoke
 * Then run the bundle with Node 24+ and --run in a disposable Linux VM.
 * No browser, server database, provider credentials, or host display is used.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@getpaperplane/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Redacted from "effect/Redacted";
import * as Readline from "node:readline";

import * as ServerConfig from "../src/config.ts";
import * as CuaDriver from "../src/computerUse/CuaDriver.ts";
import * as LinuxDesktopSetup from "../src/computerUse/LinuxDesktopSetup.ts";
import * as ProcessRunner from "../src/processRunner.ts";
import * as ServerSettings from "../src/serverSettings.ts";

const decodeWindows = Schema.decodeUnknownEffect(
  Schema.Struct({
    windows: Schema.Array(
      Schema.Struct({
        pid: Schema.Int,
        window_id: Schema.Int,
        title: Schema.String,
      }),
    ),
  }),
);
const decodeState = Schema.decodeUnknownEffect(
  Schema.Struct({
    window_title: Schema.String,
    elements_complete: Schema.Boolean,
    elements: Schema.Array(
      Schema.Struct({
        role: Schema.String,
        value: Schema.optional(Schema.String),
        element_token: Schema.String,
      }),
    ),
  }),
);

const verify = (authorization?: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    if (authorization) yield* LinuxDesktopSetup.install(authorization);
    const driver = yield* CuaDriver.make();
    yield* Effect.log("Installing Computer Use through the real service.");
    const installed = yield* driver.control({ action: "install" });
    if (installed.status !== "running" || installed.readiness.platform !== "linux")
      return yield* Effect.die("Install did not return a running Linux desktop.");
    if (
      installed.readiness.diagnostics === null ||
      installed.readiness.diagnostics.some((probe) => probe.status === "err")
    )
      return yield* Effect.die("Installed desktop has missing or failed health checks.");
    yield* Effect.log("Linux desktop is healthy.", {
      version: installed.version,
      checks: installed.readiness.diagnostics.map(({ label, status }) => ({ label, status })),
    });

    const thread = ThreadId.make("linux-computer-use-smoke");
    const catalog = yield* driver.catalog(thread);
    for (const required of ["launch_app", "get_window_state", "list_windows", "type_text"]) {
      if (!catalog.tools.some(({ name }) => name === required))
        return yield* Effect.die(`Driver catalog is missing ${required}.`);
    }
    const call = Effect.fn("smoke.call")(function* (
      name: string,
      args: CuaDriver.CuaArguments = {},
    ) {
      const result = yield* driver.call(name, args, thread, "isolated-desktop");
      if (result.isError)
        return yield* Effect.die(
          `Computer-use tool ${name} failed: ${result.content
            .flatMap((item) => (item.type === "text" ? [item.text] : []))
            .join(" ")
            .slice(0, 2000)}`,
        );
      return result;
    });
    yield* call("launch_app", {
      launch_path: "mousepad",
      additional_arguments: ["--disable-server"],
    });
    const listing = yield* call("list_windows");
    const window = (yield* decodeWindows(listing.structuredContent)).windows.find(({ title }) =>
      title.includes("Mousepad"),
    );
    if (!window) return yield* Effect.die("Mousepad did not open in the private desktop.");
    const target = {
      pid: window.pid,
      window_id: window.window_id,
      timeout_ms: 10_000,
      max_image_dimension: 900,
      tree_format: "elements",
    };
    const before = yield* call("get_window_state", target);
    const state = yield* decodeState(before.structuredContent);
    const editor = state.elements.find(({ role }) => role === "text");
    if (!state.elements_complete || !editor || (editor.value ?? "") !== "")
      return yield* Effect.die("Mousepad did not expose an empty accessibility editor.");
    const text = "Paperplane headless installation verified";
    yield* call("type_text", {
      pid: target.pid,
      window_id: target.window_id,
      element_token: editor.element_token,
      delivery_mode: "foreground",
      text,
    });
    const after = yield* call("get_window_state", target);
    const updated = yield* decodeState(after.structuredContent);
    if (!updated.elements.some((element) => element.role === "text" && element.value === text))
      return yield* Effect.die("Mousepad did not expose the text entered by Computer Use.");
    yield* Effect.log("Mousepad text verified through its accessibility state.", {
      title: updated.window_title,
      text,
    });

    const repeated = yield* driver.control({ action: "install" });
    if (repeated.status !== "running" || repeated.readiness.platform !== "linux")
      return yield* Effect.die("Repeated Install did not preserve a working desktop.");
    const runner = yield* ProcessRunner.ProcessRunner;
    const podman = yield* runner.run({ command: "podman", args: ["--version"] });
    if (podman.code !== 0) return yield* Effect.die("Cannot read the installed Podman version.");
    yield* call("close_desktop");
    yield* Effect.log(
      "PASS: real headless install, private desktop, Mousepad text, and repeated Install.",
      {
        podman: podman.stdout.trim().slice(0, 100),
        cuaDriver: installed.version,
      },
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        ProcessRunner.layer,
        ServerSettings.layerTest({ enableAgentComputerUse: true }),
        ServerConfig.layerTest(process.cwd(), { prefix: "paperplane-linux-smoke-" }),
      ).pipe(Layer.provideMerge(NodeServices.layer)),
    ),
  );

if (import.meta.main) {
  const flags = process.argv.slice(2).join(" ");
  if (flags !== "--run" && flags !== "--run --authorization-from-stdin") {
    process.stdout.write(
      "Disposable Linux smoke test. Pass --run to authorize real system package and Computer Use installation.\n",
    );
  } else if (process.platform !== "linux" || process.getuid?.() === 0) {
    process.stderr.write(
      "Run as a regular user on a disposable Linux host with sudo authorization.\n",
    );
    process.exitCode = 1;
  } else {
    let authorization: Redacted.Redacted<string> | undefined;
    if (flags.includes("--authorization-from-stdin")) {
      const input = Readline.createInterface({ input: process.stdin });
      for await (const line of input) {
        authorization = Redacted.make(line);
        input.close();
        break;
      }
      if (authorization === undefined) throw new Error("Expected one authorization line on stdin.");
    }
    try {
      await Effect.runPromise(verify(authorization));
    } finally {
      if (authorization) Redacted.wipeUnsafe(authorization);
    }
  }
}
