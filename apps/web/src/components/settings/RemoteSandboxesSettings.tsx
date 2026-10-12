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
import { AlertCircleIcon, ChevronDownIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { sandboxEnvironment } from "../../state/sandbox";
import { useEnvironmentSessionState } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { connectPairing } from "../../connection/onboarding";
import { requestConfirmDialog } from "../../confirmDialog";
import { newThreadId } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Menu, MenuItem, MenuPopup, MenuSeparator, MenuTrigger } from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";
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
    <SettingsSection
      id="remote-sandboxes"
      title="Remote sandboxes"
      headerAction={
        <Badge variant="secondary" size="sm">
          Preview
        </Badge>
      }
    >
      {!environment ? (
        <SettingsRow
          title="Select an environment"
          description="Select one connected environment to manage its sandboxes."
        />
      ) : environment.serverConfig?.environment.capabilities.remoteSandboxes !== true ? (
        <SettingsRow
          title="Server update required"
          description="Update the selected Rove server to manage remote sandboxes."
        />
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
      else setError("Could not load remote sandbox configuration. Try Refresh.");
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
    setError(null);
  };
  const configured = inventory?.configuredProviders.includes(provider) ?? false;
  const tracked = inventory?.sandboxes.some((sandbox) => sandbox.provider === provider) ?? false;
  const providerName = provider === "boat" ? "Boat" : "Modal";
  const dashboardUrl =
    provider === "boat" ? "https://boat.dev/dashboard" : "https://modal.com/apps";
  const hasRecordedError =
    inventory?.sandboxes.some((sandbox) => sandbox.detail === error) ?? false;
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
  const forget = async (sandbox: RemoteSandbox) => {
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
    <fieldset disabled={!allowed} className="min-w-0 divide-y divide-border/50">
      <legend className="sr-only">Remote sandbox account and lifecycle</legend>
      {!allowed ? (
        <p className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          Administrative access is required to manage remote sandboxes.
        </p>
      ) : null}
      <SettingsRow
        title="Provider"
        description="Run a thread on remote Linux compute. Work continues when this machine disconnects."
        control={
          <div className="w-full @min-[32rem]/settings-row:w-40">
            <Select
              value={provider}
              disabled={busy}
              onValueChange={(next) => {
                if (next === "boat" || next === "modal") changeProvider(next);
              }}
            >
              <SelectTrigger size="sm" aria-label="Sandbox provider">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="boat">Boat</SelectItem>
                <SelectItem value="modal">Modal</SelectItem>
              </SelectPopup>
            </Select>
          </div>
        }
      />
      {configured ? (
        <SettingsRow
          title={`${providerName} credentials`}
          description={
            tracked
              ? "Delete this provider's tracked sandboxes before changing credentials."
              : "Saved on this environment. No account credentials are copied to sandboxes."
          }
          status={
            <Badge variant="success" size="sm">
              Saved
            </Badge>
          }
          control={
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
          }
        />
      ) : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (!token.trim() || busy || (provider === "modal" && !tokenId.trim())) return;
            void run(async () => {
              value(await configure({ environmentId, input: { provider, token, tokenId } }));
              setToken("");
              setTokenId("");
            });
          }}
        >
          <SettingsRow
            title={`${providerName} credentials`}
            description="Use your own account. Saving credentials does not start compute."
            control={
              <div className="flex w-full flex-col gap-2 @min-[32rem]/settings-row:w-72">
                {provider === "modal" ? (
                  <Input
                    size="sm"
                    aria-label="Modal token ID"
                    placeholder="Token ID"
                    value={tokenId}
                    onChange={(event) => setTokenId(event.target.value)}
                    autoComplete="off"
                    disabled={busy || tracked}
                    required
                  />
                ) : null}
                <div className="flex items-center gap-2">
                  <Input
                    size="sm"
                    type="password"
                    aria-label={provider === "boat" ? "Boat API key" : "Modal token secret"}
                    placeholder={provider === "boat" ? "API key" : "Token secret"}
                    value={token}
                    onChange={(event) => setToken(event.target.value)}
                    autoComplete="off"
                    disabled={busy || tracked}
                    required
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    type="submit"
                    disabled={
                      busy || tracked || !token.trim() || (provider === "modal" && !tokenId.trim())
                    }
                  >
                    Save
                  </Button>
                </div>
              </div>
            }
          />
        </form>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!configured || !label.trim() || busy) return;
          void (async () => {
            if (
              !(await requestConfirmDialog(
                `Create a remote sandbox on your ${providerName} account? Compute billing starts immediately. No agent prompt will be sent. Pause or delete it when finished.`,
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
        <SettingsRow
          title="New sandbox"
          description={
            provider === "boat"
              ? "4 vCPU / 8 GB. Requires Boat billing setup and a plan that supports unlimited runtime."
              : "2 cores / 8 GiB, up to 24 hours per run. Compute, persistent storage and snapshots may be billed."
          }
          control={
            <div className="flex w-full items-center gap-2 @min-[32rem]/settings-row:w-72">
              <Input
                size="sm"
                aria-label="Sandbox name"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                maxLength={80}
                placeholder="Sandbox name"
                disabled={busy || !configured}
                required
              />
              <Button size="sm" type="submit" disabled={busy || !configured || !label.trim()}>
                Create…
              </Button>
            </div>
          }
        >
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pt-2 pb-2">
            <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
              Connect to create a blank thread, then clone a repository and sign in to a coding
              provider there. Pause manually when work finishes; settling a thread does not stop
              billing.
            </p>
            <Button
              size="xs"
              variant="ghost-muted"
              render={<a href={dashboardUrl} target="_blank" rel="noopener noreferrer" />}
            >
              {providerName} dashboard <ExternalLinkIcon />
            </Button>
          </div>
        </SettingsRow>
      </form>
      {error && !hasRecordedError ? <SandboxErrorMessage message={error} /> : null}
      {busy ? (
        <p role="status" className="px-3 py-3 text-xs text-muted-foreground sm:px-4">
          Working on the sandbox…
        </p>
      ) : null}
      <SettingsRow
        title="Sandboxes"
        description={
          inventory === null
            ? "Loading saved state…"
            : inventory.sandboxes.length === 0
              ? "No sandboxes yet. Add credentials and create one above."
              : "Pausing keeps files and conversations, but interrupts running work. Resume to reconnect."
        }
        control={
          <Button size="xs" variant="ghost-muted" disabled={busy} onClick={() => void run(refresh)}>
            <RefreshCwIcon /> Refresh
          </Button>
        }
      />
      {inventory?.sandboxes.map((sandbox) => (
        <SettingsRow
          key={sandbox.id}
          title={<span className="break-words [overflow-wrap:anywhere]">{sandbox.label}</span>}
          description={sandbox.provider === "boat" ? "Boat" : "Modal"}
          status={
            <Badge
              size="sm"
              variant={
                sandbox.phase === "error"
                  ? "error"
                  : sandbox.phase === "running"
                    ? "success"
                    : "secondary"
              }
            >
              {sandbox.phase === "error"
                ? "Failed"
                : sandbox.phase === "running"
                  ? "Running"
                  : sandbox.phase === "paused"
                    ? "Paused"
                    : sandbox.phase === "creating"
                      ? "Creating"
                      : "Deleting"}
            </Badge>
          }
          control={
            <>
              {sandbox.phase === "running" ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void open(sandbox)}
                >
                  {sandbox.threadId ? "Open thread" : "Connect & create thread"}
                </Button>
              ) : null}
              <Menu>
                <MenuTrigger
                  render={
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={busy || !allowed}
                      aria-label={`Actions for ${sandbox.label}`}
                    />
                  }
                >
                  Actions <ChevronDownIcon />
                </MenuTrigger>
                <MenuPopup align="end">
                  <MenuItem
                    disabled={!sandbox.remoteId || sandbox.phase === "deleting"}
                    onClick={() =>
                      void operate(sandbox, sandbox.phase === "running" ? "pause" : "resume")
                    }
                  >
                    {sandbox.phase === "running" ? "Pause sandbox…" : "Resume / repair…"}
                  </MenuItem>
                  <MenuItem
                    render={
                      <a
                        href={
                          sandbox.provider === "boat"
                            ? "https://boat.dev/dashboard"
                            : "https://modal.com/apps"
                        }
                        target="_blank"
                        rel="noopener noreferrer"
                      />
                    }
                  >
                    Open vendor dashboard <ExternalLinkIcon />
                  </MenuItem>
                  <MenuSeparator />
                  <MenuItem variant="destructive" onClick={() => void operate(sandbox, "delete")}>
                    Delete sandbox…
                  </MenuItem>
                  {sandbox.phase === "error" || sandbox.phase === "deleting" ? (
                    <MenuItem variant="destructive" onClick={() => void forget(sandbox)}>
                      Forget failed record…
                    </MenuItem>
                  ) : null}
                </MenuPopup>
              </Menu>
            </>
          }
        >
          {sandbox.detail ? (
            <div className="pt-2 pb-2">
              <SandboxErrorMessage message={sandbox.detail} inline />
            </div>
          ) : null}
          {sandbox.phase === "error" ? (
            <p className="pb-2 text-xs leading-normal text-muted-foreground/80">
              Resources may still be billing. Check the vendor dashboard before retrying or
              forgetting this record.
            </p>
          ) : null}
        </SettingsRow>
      ))}
    </fieldset>
  );
}

function SandboxErrorMessage({ message, inline = false }: { message: string; inline?: boolean }) {
  return (
    <div
      role="alert"
      className={inline ? "flex items-start gap-2" : "flex items-start gap-2 px-3 py-3 sm:px-4"}
    >
      <AlertCircleIcon
        aria-hidden
        className="mt-0.5 size-3.5 shrink-0 text-destructive-foreground"
      />
      <p className="max-w-xl break-words text-xs leading-relaxed text-destructive-foreground">
        {message}
      </p>
    </div>
  );
}
