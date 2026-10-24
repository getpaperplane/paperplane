// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { createPackageWithOptions } from "@electron/asar";
import { afterEach, assert, it } from "vite-plus/test";
import { verifyWindowsPeArchitecture } from "./windows-pe.ts";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

function pe(machine = 0xaa64) {
  const bytes = Buffer.alloc(256);
  bytes.write("MZ");
  bytes.writeUInt32LE(128, 0x3c);
  bytes.write("PE\0\0", 128);
  bytes.writeUInt16LE(machine, 132);
  return bytes;
}

async function directory() {
  const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "paperplane-pe-test-"));
  temporaryDirectories.push(root);
  return root;
}

it("checks loose binaries and both packed and unpacked ASAR natives", async () => {
  const root = await directory();
  const app = NodePath.join(root, "app");
  await NodeFSP.mkdir(app);
  await NodeFSP.writeFile(NodePath.join(app, "paperplane.exe"), pe());
  const source = NodePath.join(root, "source");
  await NodeFSP.mkdir(source);
  await NodeFSP.writeFile(NodePath.join(source, "packed.node"), pe());
  await NodeFSP.writeFile(NodePath.join(source, "unpacked.dll"), pe());
  await createPackageWithOptions(source, NodePath.join(app, "server.asar"), { unpack: "*.dll" });
  assert.equal(await verifyWindowsPeArchitecture(app, "arm64"), 3);
});

it.each([0x8664, 0x14c, 0xa641, 0xa64e])("rejects non-ARM64 PE machine %s", async (machine) => {
  const app = await directory();
  await NodeFSP.writeFile(NodePath.join(app, "addon.node"), pe(machine));
  await NodeAssert.rejects(verifyWindowsPeArchitecture(app, "arm64"), /expected arm64 PE machine/);
});

it("rejects a host prebuild hidden inside a packed ASAR", async () => {
  const root = await directory();
  const app = NodePath.join(root, "app");
  const source = NodePath.join(root, "source");
  await NodeFSP.mkdir(app);
  await NodeFSP.mkdir(source);
  await NodeFSP.writeFile(NodePath.join(source, "host.node"), pe(0x8664));
  await createPackageWithOptions(source, NodePath.join(app, "app.asar"), {});
  await NodeAssert.rejects(verifyWindowsPeArchitecture(app, "arm64"), /host.node: expected arm64/);
});

it.each([Buffer.from("not PE"), Buffer.from("MZ"), Buffer.alloc(64)])(
  "rejects malformed native files",
  async (bytes) => {
    const app = await directory();
    await NodeFSP.writeFile(NodePath.join(app, "broken.exe"), bytes);
    await NodeAssert.rejects(verifyWindowsPeArchitecture(app, "arm64"), /DOS PE header/);
  },
);

it("rejects a truncated PE header and invalid signature", async () => {
  const app = await directory();
  const file = NodePath.join(app, "broken.dll");
  await NodeFSP.writeFile(file, pe().subarray(0, 130));
  await NodeAssert.rejects(verifyWindowsPeArchitecture(app, "arm64"), /PE signature/);
  const invalid = pe();
  invalid.write("NO", 128);
  await NodeFSP.writeFile(file, invalid);
  await NodeAssert.rejects(verifyWindowsPeArchitecture(app, "arm64"), /PE signature/);
});

it("allows only the pinned x86 NSIS elevation helper at its exact loose path", async () => {
  const app = await directory();
  const resources = NodePath.join(app, "resources");
  await NodeFSP.mkdir(resources);
  const elevate = NodePath.join(resources, "elevate.exe");
  await NodeFSP.writeFile(elevate, pe(0x014c));
  assert.equal(await verifyWindowsPeArchitecture(app, "arm64"), 1);
  await NodeFSP.writeFile(elevate, pe(0x8664));
  await NodeAssert.rejects(verifyWindowsPeArchitecture(app, "arm64"), /expected ia32.*got 0x8664/);
  await NodeFSP.rm(elevate);
  await NodeFSP.writeFile(NodePath.join(app, "elevate.exe"), pe(0x014c));
  await NodeAssert.rejects(verifyWindowsPeArchitecture(app, "arm64"), /expected arm64.*got 0x14c/);
});

it("rejects a missing ASAR-unpacked native file", async () => {
  const root = await directory();
  const app = NodePath.join(root, "app");
  const source = NodePath.join(root, "source");
  await NodeFSP.mkdir(app);
  await NodeFSP.mkdir(source);
  await NodeFSP.writeFile(NodePath.join(source, "missing.node"), pe());
  const archive = NodePath.join(app, "app.asar");
  await createPackageWithOptions(source, archive, { unpack: "*.node" });
  await NodeFSP.rm(`${archive}.unpacked`, { recursive: true });
  await NodeAssert.rejects(verifyWindowsPeArchitecture(app, "arm64"), /ENOENT/);
});

it("does not report success on an empty app directory", async () => {
  await NodeAssert.rejects(
    verifyWindowsPeArchitecture(await directory(), "arm64"),
    /No PE binaries/,
  );
});
