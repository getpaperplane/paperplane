import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, it } from "vite-plus/test";
import * as HostProcess from "@getpaperplane/shared/HostProcess";

const directories = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    NodeFS.rmSync(directory, { recursive: true, force: true });
});

it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
  "creates a password-protected code-signing identity without replacing it on retry",
  () => {
    const directory = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "paperplane-windows-certificate-"),
    );
    directories.push(directory);
    const env = { ...process.env, PAPERPLANE_CERTIFICATE_PASSWORD: "certificate-test-password" };
    const script = NodePath.join(import.meta.dirname, "create-windows-signing.sh");
    NodeChildProcess.execFileSync("bash", [script, directory], { env, stdio: "pipe" });
    const pfx = NodePath.join(directory, "paperplane-windows-signing.pfx");
    const cert = new NodeCrypto.X509Certificate(
      NodeFS.readFileSync(NodePath.join(directory, "paperplane-windows-signing.cer")),
    );
    NodeAssert.deepEqual(cert.keyUsage, ["1.3.6.1.5.5.7.3.3"]);
    NodeAssert.equal(cert.ca, false);
    NodeAssert.equal(cert.subject, "CN=Paperplane Release Signing");
    NodeAssert.equal(cert.subject, cert.issuer);
    NodeAssert.equal(cert.verify(cert.publicKey), true);
    const before = NodeFS.readFileSync(pfx);
    NodeChildProcess.execFileSync(
      "openssl",
      ["pkcs12", "-in", pfx, "-noout", "-passin", "env:PAPERPLANE_CERTIFICATE_PASSWORD"],
      { env, stdio: "pipe" },
    );
    NodeAssert.throws(() =>
      NodeChildProcess.execFileSync(
        "openssl",
        ["pkcs12", "-in", pfx, "-noout", "-passin", "pass:wrong"],
        { stdio: "pipe" },
      ),
    );
    NodeAssert.throws(
      () => NodeChildProcess.execFileSync("bash", [script, directory], { env, stdio: "pipe" }),
      /Refusing to replace/,
    );
    NodeAssert.deepEqual(NodeFS.readFileSync(pfx), before);
  },
  20_000,
);
