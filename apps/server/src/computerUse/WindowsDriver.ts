/** The installer requires Authenticode from 0.22 onward. Older unsigned releases
 * have archive checksums: compare their extracted payload before executing anything.
 * The caller resolves the installer's junctions without executing the driver.
 */
export const windowsVerificationScript = (resolvedPath: string) => {
  const release =
    /[/\\]releases[/\\]([0-9]+\.[0-9]+\.[0-9]+(?:-nightly\.[0-9.]+)?)-(x86_64|aarch64)-pc-windows-msvc[/\\]cua-driver\.exe$/i.exec(
      resolvedPath,
    );
  if (!release) return undefined;
  const [, version, arch] = release;
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const [major, minor] = (version ?? "0.0").split(".").map(Number);
  if ((major ?? 0) > 0 || (minor ?? 0) >= 22)
    return `
$ErrorActionPreference = 'Stop'
try {
  $files = @(Get-ChildItem -LiteralPath (Split-Path -Parent ${quote(resolvedPath)}) -File -Filter *.exe)
  if ($files.Count -eq 0) { throw 'Missing driver' }
  foreach ($file in $files) {
    $signature = Get-AuthenticodeSignature -FilePath $file.FullName
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\\s*)CN="?Cua AI, Inc\\."?(?:,|$)') { throw 'Invalid Cua AI, Inc. Authenticode signature' }
  }
} catch { Write-Error $_; exit 1 }
`;
  const tag = `${version?.includes("-nightly.") ? "nightly-" : ""}cua-driver-rs-v${version}`;
  const asset = `cua-driver-rs-${version}-windows-${arch === "aarch64" ? "arm64" : "x86_64"}-binary.zip`;
  return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$installed = ${quote(resolvedPath)}
$asset = '${asset}'
$base = 'https://github.com/trycua/cua/releases/download/${tag}'
$temp = Join-Path ([IO.Path]::GetTempPath()) ([Guid]::NewGuid().ToString())
try {
  New-Item -ItemType Directory -Path $temp | Out-Null
  $checksums = (Invoke-WebRequest -UseBasicParsing "$base/checksums.txt").Content
  $expected = @($checksums -split '\n' | Where-Object { $_.Trim() -match ('^[a-fA-F0-9]{64}\\s+\\*?' + [regex]::Escape($asset) + '$') })
  if ($expected.Count -ne 1) { throw 'No unique release checksum' }
  $zip = Join-Path $temp 'release.zip'
  Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile $zip
  if ((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne ($expected[0] -split '\\s+')[0]) { throw 'Release checksum mismatch' }
  $payload = Join-Path $temp 'payload'
  Expand-Archive -LiteralPath $zip -DestinationPath $payload
  # The installer copies executable siblings, not the SDK DLL / Node addon.
  $files = @(Get-ChildItem -LiteralPath $payload -Recurse -File -Filter *.exe)
  if (-not ($files | Where-Object { $_.Name -eq 'cua-driver.exe' })) { throw 'Missing driver in release' }
  foreach ($file in $files) {
    $local = Join-Path (Split-Path -Parent $installed) $file.Name
    if ((Get-FileHash -LiteralPath $local -Algorithm SHA256).Hash -ne (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash) { throw 'Installed payload checksum mismatch' }
  }
} catch { Write-Error $_; exit 1 } finally { Remove-Item -LiteralPath $temp -Recurse -Force -ErrorAction SilentlyContinue }
`;
};

export const WINDOWS_SOCKET = String.raw`\\.\pipe\cua-driver`;
export const WINDOWS_SETUP_DETAIL =
  "Cua Driver's interactive desktop daemon is not running. Sign in to the Windows desktop, then use Settings → Integrations to start it (autostart kick). SSH and Session 0 cannot host the daemon.";
