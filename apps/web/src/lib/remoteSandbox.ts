const GITHUB_SSH = /^(?:ssh:\/\/)?git@github\.com[:/](.+?)(?:\.git)?\/?$/;

/**
 * Sandboxes authenticate git through the forwarded GitHub sign-in, which only
 * covers HTTPS, so clone GitHub SSH remotes over HTTPS there.
 */
export function sandboxCloneUrl(remoteUrl: string): string {
  const match = GITHUB_SSH.exec(remoteUrl.trim());
  return match ? `https://github.com/${match[1]}.git` : remoteUrl;
}

/** The folder a remote clones into, matching git's own default. */
export function cloneDirectoryName(remoteUrl: string): string {
  const last = remoteUrl.trim().replace(/\/+$/, "").split(/[/:]/).at(-1) ?? "";
  return last.replace(/\.git$/, "") || "project";
}
