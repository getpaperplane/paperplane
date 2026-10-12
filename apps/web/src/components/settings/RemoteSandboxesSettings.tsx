import { useEffect, useRef, useState } from "react";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@rove-code/client-runtime/state/runtime";
import {
  standaloneThreadInput,
  supportsStandaloneThreads,
} from "@rove-code/client-runtime/state/standalone-thread";
import {
  type EnvironmentId,
  type RemoteSandbox,
  SandboxInventory,
  type SandboxProvider,
} from "@rove-code/contracts";
import { useRouter } from "@tanstack/react-router";
import { sandboxEnvironment } from "../../state/sandbox";
import { useEnvironmentSessionState } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { requestConfirmDialog } from "../../confirmDialog";
import { newThreadId } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

function value<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw Cause.squash(result.cause);
  return result.value;
}

export function RemoteSandboxesSettings() {
  const { connectedEnvironments, scope } = useSettingsScope();
  const environment =
    connectedEnvironments.length === 1 && scope.kind !== "project" && scope.kind !== "checkout"
      ? connectedEnvironments[0]
      : undefined;
  return (
    <SettingsSection id="remote-sandboxes" title="Remote sandboxes · Preview">
      <p className="mb-4 text-sm text-muted-foreground">
        Run a thread in its own remote Linux environment using your Boat or Modal account. Agent
        work continues without this machine. Lifecycle controls are manual in this preview: settle a
        thread, then pause its sandbox. No account credentials are copied from this environment.
      </p>
      {!environment ? (
        <p className="text-sm text-muted-foreground">
          Select one connected environment to manage its sandboxes.
        </p>
      ) : environment.serverConfig?.environment.capabilities.remoteSandboxes !== true ? (
        <p className="text-sm text-muted-foreground">
          Update the selected Rove server to manage remote sandboxes.
        </p>
      ) : (
        <SandboxControls
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      )}
    </SettingsSection>
  );
}

function SandboxControls({ environmentId }: { environmentId: EnvironmentId }) {
  const session = useEnvironmentSessionState(environmentId);
  const allowed = !session.hasError && (session.data?.scopes?.includes("access:write") ?? false);
  const inventoryCommand = useAtomCommand(sandboxEnvironment.inventory, { reportFailure: false });
  const configure = useAtomCommand(sandboxEnvironment.configure, { reportFailure: false });
  const create = useAtomCommand(sandboxEnvironment.create, { reportFailure: false });
  const action = useAtomCommand(sandboxEnvironment.action, { reportFailure: false });
  const link = useAtomCommand(sandboxEnvironment.link, { reportFailure: false });
  const getConfig = useAtomCommand(sandboxEnvironment.getConfig, { reportFailure: false });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const router = useRouter();
  const [inventory, setInventory] = useState<typeof SandboxInventory.Type | null>(null);
  const [provider, setProvider] = useState<SandboxProvider>("boat");
  const [token, setToken] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void inventoryCommand({ environmentId, input: {} }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") setInventory(result.value);
      else setError("Could not load remote sandbox configuration.");
    });
    return () => {
      active = false;
    };
  }, [environmentId, inventoryCommand]);
  const refresh = async () =>
    setInventory(value(await inventoryCommand({ environmentId, input: {} })));
  const run = async (work: () => Promise<void>) => {
    if (!allowed || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Sandbox operation failed.");
    } finally {
      await refresh().catch(() => {});
      busyRef.current = false;
      setBusy(false);
    }
  };
  const changeProvider = (next: SandboxProvider) => {
    setProvider(next);
    setToken("");
    setTokenId("");
  };
  const configured = inventory?.configuredProviders.includes(provider) ?? false;
  const tracked = inventory?.sandboxes.some((sandbox) => sandbox.provider === provider) ?? false;
  const operate = async (sandbox: RemoteSandbox, kind: "pause" | "resume" | "delete") => {
    const message =
      kind === "delete"
        ? `Permanently delete ${sandbox.label}, its workspace, credentials, and recovery snapshots? This cannot be undone. If provisioning failed without an ID, first verify and remove any resources in the vendor dashboard.`
        : kind === "pause"
          ? `Pause ${sandbox.label}? This stops its Rove server and interrupts any running agent, build, or terminal. Files and persisted conversations are retained.`
          : `Resume ${sandbox.label}? This starts compute billing on your ${sandbox.provider} account.`;
    if (
      !(await requestConfirmDialog(message, {
        variant: kind === "delete" ? "destructive" : "default",
      }))
    )
      return;
    await run(async () => {
      value(
        await action({ environmentId, input: { id: sandbox.id, action: kind, confirmed: true } }),
      );
    });
  };
  const open = async (sandbox: RemoteSandbox) =>
    run(async () => {
      const result = value(
        await action({ environmentId, input: { id: sandbox.id, action: "pair", confirmed: true } }),
      );
      if (!result.pairingUrl) throw new Error("Pairing URL is unavailable.");
      const targetId = value(await pair({ pairingUrl: result.pairingUrl }));
      const config = value(await getConfig({ environmentId: targetId, input: {} }));
      if (!supportsStandaloneThreads(config))
        throw new Error(
          "Update the sandbox's Rove installation before creating a standalone thread.",
        );
      if (sandbox.environmentId !== null && sandbox.environmentId !== targetId)
        throw new Error("Sandbox identity changed. Existing thread was not replaced.");
      const threadId = sandbox.threadId ?? newThreadId();
      if (sandbox.threadId === null) {
        value(
          await createThread({
            environmentId: targetId,
            input: standaloneThreadInput(threadId, config),
          }),
        );
        value(
          await link({
            environmentId,
            input: { id: sandbox.id, environmentId: targetId, threadId },
          }),
        );
      }
      await router.navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId: targetId, threadId },
      });
    });
  return (
    <fieldset disabled={!allowed}>
      {!allowed ? (
        <p className="mb-4 text-sm text-muted-foreground">
          Administrative access is required to manage remote sandboxes.
        </p>
      ) : null}
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Sandbox provider">
          {(["boat", "modal"] as const).map((name) => (
            <Button
              key={name}
              size="sm"
              variant={provider === name ? "default" : "outline"}
              disabled={busy}
              onClick={() => changeProvider(name)}
            >
              {name === "boat" ? "Boat" : "Modal"}
            </Button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          {provider === "boat"
            ? "Boat default: 4 vCPU / 8 GB, currently $0.036/hour. Stopped storage is advertised as free; confirm retention with Boat."
            : "Modal: 2 physical cores / 8 GiB, up to 24 hours per run. A dedicated persistent volume retains thread data across runs. Compute, volumes, and snapshots may be billed; free credits are limited."}
        </p>
        <p className="text-sm">
          Credentials: {configured ? "Configured on this environment" : "Not configured"}
        </p>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            if (!token.trim() || busy) return;
            void run(async () => {
              value(
                await configure({
                  environmentId,
                  input: { provider, token, tokenId },
                }),
              );
              setToken("");
              setTokenId("");
            });
          }}
        >
          {provider === "modal" ? (
            <label className="block space-y-1 text-sm">
              <span>Modal token ID</span>
              <Input
                value={tokenId}
                onChange={(event) => setTokenId(event.target.value)}
                autoComplete="off"
                disabled={busy || tracked}
                required
              />
            </label>
          ) : null}
          <label className="block space-y-1 text-sm">
            <span>{provider === "boat" ? "Boat API key" : "Modal token secret"}</span>
            <Input
              type="password"
              value={token}
              onChange={(event) => setToken(event.target.value)}
              autoComplete="off"
              disabled={busy || tracked}
              required
            />
          </label>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="outline"
              type="submit"
              disabled={
                busy || tracked || !token.trim() || (provider === "modal" && !tokenId.trim())
              }
            >
              Save credentials
            </Button>
            {configured ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || tracked}
                onClick={() =>
                  void run(async () => {
                    value(await configure({ environmentId, input: { provider, token: "" } }));
                  })
                }
              >
                Remove credentials
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            Saving credentials does not contact the vendor or start compute. Delete tracked
            sandboxes before changing accounts.
          </p>
        </form>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!configured || !label.trim() || busy) return;
            void (async () => {
              if (
                !(await requestConfirmDialog(
                  `Create a remote sandbox on your ${provider} account? Compute billing starts immediately. No agent prompt will be sent. Pause or delete it when finished.`,
                ))
              )
                return;
              await run(async () => {
                value(
                  await create({
                    environmentId,
                    input: { provider, label: label.trim(), confirmCost: true },
                  }),
                );
                setLabel("");
              });
            })();
          }}
        >
          <label className="min-w-48 flex-1 space-y-1 text-sm">
            <span>Thread sandbox name</span>
            <Input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={80}
              placeholder="My remote task"
              disabled={busy}
              required
            />
          </label>
          <Button size="sm" type="submit" disabled={busy || !configured || !label.trim()}>
            Create sandbox…
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          Connect to create one blank thread, then sign in to a coding provider inside that
          environment. Existing repositories and local provider credentials are not uploaded
          automatically. Viewing a transcript through the remote connection requires the sandbox to
          be running.
        </p>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {busy ? (
          <p role="status" className="text-sm text-muted-foreground">
            Working on the sandbox…
          </p>
        ) : null}
        <div className="space-y-3">
          {inventory?.sandboxes.map((sandbox) => (
            <div key={sandbox.id} className="border-t border-border py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">{sandbox.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {sandbox.provider} · {sandbox.phase}
                    {sandbox.phase === "error" ? " (may still be billing)" : ""}{" "}
                    {sandbox.remoteId ? `· ${sandbox.remoteId}` : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || sandbox.phase !== "running"}
                    onClick={() => void open(sandbox)}
                  >
                    {sandbox.threadId ? "Open thread" : "Connect & create thread"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || !sandbox.remoteId}
                    onClick={() =>
                      void operate(sandbox, sandbox.phase === "running" ? "pause" : "resume")
                    }
                  >
                    {sandbox.phase === "running" ? "Pause…" : "Resume / repair…"}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void operate(sandbox, "delete")}
                  >
                    Delete…
                  </Button>
                  {sandbox.phase === "error" || sandbox.phase === "deleting" ? (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy}
                      onClick={() =>
                        void (async () => {
                          if (
                            !(await requestConfirmDialog(
                              "Forget this failed record only? This does NOT stop billing or delete vendor resources. Verify cleanup in the vendor dashboard first. Saved recovery handles will be lost.",
                              { variant: "destructive" },
                            ))
                          )
                            return;
                          await run(async () => {
                            value(
                              await action({
                                environmentId,
                                input: { id: sandbox.id, action: "forget", confirmed: true },
                              }),
                            );
                          });
                        })()
                      }
                    >
                      Forget failed record…
                    </Button>
                  ) : null}
                </div>
              </div>
              {sandbox.detail ? (
                <p className="mt-2 text-sm text-destructive">{sandbox.detail}</p>
              ) : null}
            </div>
          ))}
        </div>
        <Button size="sm" variant="outline" disabled={busy} onClick={() => void run(refresh)}>
          Refresh saved state
        </Button>
      </div>
    </fieldset>
  );
}
