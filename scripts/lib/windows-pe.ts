// @effect-diagnostics nodeBuiltinImport:off - Packaging inspects PE headers without loading target binaries.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import { extractFile, getRawHeader, type DirectoryRecord } from "@electron/asar";

const PE_MACHINES = { x64: 0x8664, arm64: 0xaa64, ia32: 0x014c } as const;

/** Reject malformed headers, not just binaries of the wrong architecture. */
function peHeaderOffset(header: Uint8Array): number {
  if (header.length < 64 || header[0] !== 0x4d || header[1] !== 0x5a) {
    throw new Error("Missing DOS PE header");
  }
  const offset = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint32(
    0x3c,
    true,
  );
  if (offset < 64) throw new Error("Invalid PE header offset");
  return offset;
}

function verifyMachine(header: Uint8Array, arch: keyof typeof PE_MACHINES, name: string) {
  if (
    header.length < 6 ||
    header[0] !== 0x50 ||
    header[1] !== 0x45 ||
    header[2] !== 0 ||
    header[3] !== 0
  ) {
    throw new Error(`${name}: Missing PE signature`);
  }
  const machine = new DataView(header.buffer, header.byteOffset, header.byteLength).getUint16(
    4,
    true,
  );
  // ARM64EC (0xa641) and ARM64X (0xa64e) are not ordinary ARM64 addons.
  // None of our pinned payloads uses them; don't silently allow hybrids.
  if (machine !== PE_MACHINES[arch]) {
    throw new Error(
      `${name}: expected ${arch} PE machine 0x${PE_MACHINES[arch].toString(16)}, got 0x${machine.toString(16)}`,
    );
  }
}

const isNativeFile = (name: string) => /\.(node|exe|dll)$/i.test(name);

/** Check the installed app, not the NSIS bootstrapper (which is intentionally x86). */
export async function verifyWindowsPeArchitecture(appDir: string, arch: "x64" | "arm64") {
  let checked = 0;
  const checkedFiles = new Set<string>();
  const verifyFile = async (file: string) => {
    if (checkedFiles.has(file)) return;
    const handle = await NodeFSP.open(file, "r");
    try {
      const dos = Buffer.alloc(64);
      const { bytesRead } = await handle.read(dos, 0, dos.length, 0);
      const offset = peHeaderOffset(dos.subarray(0, bytesRead));
      const pe = Buffer.alloc(6);
      const result = await handle.read(pe, 0, pe.length, offset);
      // electron-builder's pinned NSIS helper is intentionally x86, even for
      // ARM64 installers. electron-updater uses it for per-machine elevation.
      // Allow only this exact loose path and only its known machine type.
      const expectedArch =
        file === NodePath.join(appDir, "resources", "elevate.exe") ? "ia32" : arch;
      verifyMachine(pe.subarray(0, result.bytesRead), expectedArch, file);
      checkedFiles.add(file);
      checked++;
    } finally {
      await handle.close();
    }
  };
  const verifyAsar = async (archive: string, directory: DirectoryRecord, parent = "") => {
    for (const [name, entry] of Object.entries(directory.files)) {
      const relative = parent ? `${parent}/${name}` : name;
      if ("files" in entry) {
        await verifyAsar(archive, entry, relative);
      } else if (isNativeFile(name) && !("link" in entry)) {
        if (entry.unpacked) {
          // Check referenced files too, so a missing .unpacked tree fails even
          // when the directory walk could not encounter it.
          await verifyFile(NodePath.join(`${archive}.unpacked`, ...relative.split("/")));
          continue;
        }
        // Also inspect packed binaries: checking only *.asar.unpacked can hide
        // a stray host-architecture prebuild that wasn't selected for unpacking.
        const bytes = extractFile(archive, relative.split("/").join(NodePath.sep));
        const offset = peHeaderOffset(bytes);
        verifyMachine(bytes.subarray(offset, offset + 6), arch, `${archive}/${relative}`);
        checked++;
      }
    }
  };
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
      const file = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else if (isNativeFile(entry.name)) await verifyFile(file);
      else if (entry.name.endsWith(".asar")) await verifyAsar(file, getRawHeader(file).header);
    }
  };
  await walk(appDir);
  if (checked === 0) throw new Error(`No PE binaries found in ${appDir}`);
  return checked;
}
