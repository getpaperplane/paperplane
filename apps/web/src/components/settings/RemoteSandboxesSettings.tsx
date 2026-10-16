import { useEffect, useRef, useState } from "react";
import * as Cause from "effect/Cause";
import type { AtomCommandResult } from "@rove-code/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type RemoteSandbox,
  type SandboxCredentialKind,
  type SandboxInventory,
  type SandboxProvider,
  type SandboxRegion,
} from "@rove-code/contracts";
import { useRouter } from "@tanstack/react-router";
import { AlertCircleIcon, ChevronDownIcon, ExternalLinkIcon, RefreshCwIcon } from "lucide-react";
import { sandboxEnvironment } from "../../state/sandbox";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentSessionState } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { environmentCatalog } from "../../connection/catalog";
import { connectPairing } from "../../connection/onboarding";
import { requestConfirmDialog } from "../../confirmDialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
  const { connectedEnvironments, environment: preferred, scope } = useSettingsScope();
  // Connecting to a sandbox adds its environment to this client. Keep managing
  // from the primary environment instead of asking for a selection.
  const environment =
    scope.kind !== "project" && scope.kind !== "checkout" ? (preferred ?? undefined) : undefined;
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
          managedBy={connectedEnvironments.length > 1 ? environment.label : null}
        />
      )}
    </SettingsSection>
  );
}

const PROVIDER_NAMES = { boat: "Boat", modal: "Modal" } satisfies Record<SandboxProvider, string>;
const DASHBOARD_URLS = {
  boat: "https://boat.dev/dashboard",
  modal: "https://modal.com/apps",
} satisfies Record<SandboxProvider, string>;
const CREDENTIAL_NAMES = {
  codex: "Codex",
  claude: "Claude",
  pi: "Pi",
  opencode: "OpenCode",
  github: "GitHub",
} satisfies Record<SandboxCredentialKind, string>;
// Modal places unpinned sandboxes anywhere at base price; pinning a broad
// region costs 1.15x.
const REGION_LABELS = {
  default: "Any · base price",
  us: "United States · 1.15x",
  eu: "Europe · 1.15x",
  ap: "Asia-Pacific · 1.15x",
} satisfies Record<SandboxRegion | "default", string>;
const PHASE_LABELS = {
  creating: "Creating",
  running: "Running",
  paused: "Paused",
  error: "Failed",
  deleting: "Deleting",
} satisfies Record<RemoteSandbox["phase"], string>;

/** Where progress is shown: the account row, the create row, or a sandbox row by id. */
type Pending = { scope: string; label: string };

function SandboxControls({
  environmentId,
  managedBy,
}: {
  environmentId: EnvironmentId;
  managedBy: string | null;
}) {
  const session = useEnvironmentSessionState(environmentId);
  const allowed = !session.hasError && (session.data?.scopes?.includes("access:write") ?? false);
  const inventoryCommand = useAtomCommand(sandboxEnvironment.inventory, { reportFailure: false });
  const configure = useAtomCommand(sandboxEnvironment.configure, { reportFailure: false });
  const create = useAtomCommand(sandboxEnvironment.create, { reportFailure: false });
  const action = useAtomCommand(sandboxEnvironment.action, { reportFailure: false });
  const pair = useAtomCommand(connectPairing, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  // Connecting saved the sandbox as an environment here; drop it with the sandbox.
  const forgetConnection = async (sandbox: RemoteSandbox) => {
    if (sandbox.environmentId) await removeEnvironment(sandbox.environmentId);
  };
  const router = useRouter();
  const [inventory, setInventory] = useState<SandboxInventory | null>(null);
  const [provider, setProvider] = useState<SandboxProvider>("boat");
  const [token, setToken] = useState("");
  const [tokenId, setTokenId] = useState("");
  const [label, setLabel] = useState("");
  const [region, setRegion] = useState<SandboxRegion | "default">("default");
  const [newCredentials, setNewCredentials] = useState<ReadonlyArray<SandboxCredentialKind>>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<Pending | null>(null);
  const busy = pending !== null;
  const locked = !allowed || busy;
  useEffect(() => {
    let active = true;
    void inventoryCommand({ environmentId, input: {} }).then((result) => {
      if (!active) return;
      if (result._tag === "Failure") {
        setError({
          scope: "list",
          label: "Could not load remote sandbox configuration. Try Refresh.",
        });
        return;
      }
      setInventory(result.value);
      // Open on the account already in use rather than always on Boat.
      const inUse =
        result.value.sandboxes[0]?.provider ?? result.value.configuredProviders[0] ?? "boat";
      setProvider(inUse);
    });
    return () => {
      active = false;
    };
  }, [environmentId, inventoryCommand]);
  // Lifecycle operations can take minutes. Inventory is a cheap read of saved
  // state, so refresh it while one runs to show records as they change.
  useEffect(() => {
    if (!busy) return;
    const timer = window.setInterval(() => {
      void inventoryCommand({ environmentId, input: {} }).then((result) => {
        if (result._tag === "Success") setInventory(result.value);
      });
    }, 3000);
    return () => window.clearInterval(timer);
  }, [busy, environmentId, inventoryCommand]);
  const refresh = async () =>
    setInventory(value(await inventoryCommand({ environmentId, input: {} })));
  const run = async (next: Pending, work: () => Promise<void>) => {
    if (!allowed || pendingRef.current) return;
    pendingRef.current = true;
    setPending(next);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError({
        scope: next.scope,
        label: cause instanceof Error ? cause.message : "Sandbox operation failed.",
      });
    } finally {
      await refresh().catch(() => {});
      pendingRef.current = false;
      setPending(null);
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
  const providerName = PROVIDER_NAMES[provider];
  // Absent on servers that predate sign-in forwarding.
  const availableCredentials = inventory?.availableCredentials;
  // Errors appear beside the row that started the operation.
  const errorIn = (scope: string, recorded?: string | null) =>
    error?.scope === scope && error.label !== recorded ? (
      <SandboxErrorMessage message={error.label} />
    ) : null;
  const operate = async (sandbox: RemoteSandbox, kind: "pause" | "resume" | "delete") => {
    const vendor = PROVIDER_NAMES[sandbox.provider];
    const message =
      kind === "delete"
        ? `Permanently delete ${sandbox.label}, its workspace, credentials, and recovery snapshots? This cannot be undone.${sandbox.remoteId ? "" : ` Provisioning returned no resource ID, so first check the ${vendor} dashboard for leftover resources.`}`
        : kind === "pause"
          ? `Pause ${sandbox.label}? This stops its Rove server and interrupts any running agent, build, or terminal. Files and persisted conversations are kept.`
          : `${sandbox.phase === "paused" ? "Resume" : "Repair"} ${sandbox.label}? This starts compute billing on your ${vendor} account.`;
    if (
      !(await requestConfirmDialog(message, {
        variant: kind === "delete" ? "destructive" : "default",
      }))
    )
      return;
    const progress =
      kind === "delete" ? "Deleting…" : kind === "pause" ? "Pausing…" : "Starting Rove…";
    await run({ scope: sandbox.id, label: progress }, async () => {
      value(
        await action({ environmentId, input: { id: sandbox.id, action: kind, confirmed: true } }),
      );
      if (kind === "delete") await forgetConnection(sandbox);
    });
  };
  const changeCredentials = (sandbox: RemoteSandbox, kind: SandboxCredentialKind, on: boolean) => {
    const current = sandbox.credentials ?? [];
    const credentials = on ? [...current, kind] : current.filter((value) => value !== kind);
    void run(
      {
        scope: sandbox.id,
        label: sandbox.phase === "running" ? "Updating sign-ins…" : "Saving sign-ins…",
      },
      async () => {
        value(
          await action({
            environmentId,
            input: { id: sandbox.id, action: "credentials", confirmed: true, credentials },
          }),
        );
        // Rove in the sandbox only re-checks providers on request.
        if (sandbox.environmentId && sandbox.phase === "running")
          await refreshProviders({ environmentId: sandbox.environmentId, input: {} });
      },
    );
  };
  const forget = async (sandbox: RemoteSandbox) => {
    if (
      !(await requestConfirmDialog(
        `Forget this record only? This does NOT stop billing or delete resources on ${PROVIDER_NAMES[sandbox.provider]}. Check the dashboard first. Saved recovery handles will be lost.`,
        { variant: "destructive" },
      ))
    )
      return;
    await run({ scope: sandbox.id, label: "Forgetting…" }, async () => {
      value(
        await action({
          environmentId,
          input: { id: sandbox.id, action: "forget", confirmed: true },
        }),
      );
      await forgetConnection(sandbox);
    });
  };
  const open = async (sandbox: RemoteSandbox) =>
    run({ scope: sandbox.id, label: "Connecting…" }, async () => {
      const result = value(
        await action({ environmentId, input: { id: sandbox.id, action: "pair", confirmed: true } }),
      );
      if (!result.pairingUrl) throw new Error("Pairing URL is unavailable.");
      const targetId = value(await pair({ pairingUrl: result.pairingUrl }));
      // Pairing is independent of orchestration. Choose or create a V2 project
      // in the connected environment instead of reviving a V1 standalone thread.
      if (sandbox.threadId && sandbox.environmentId === targetId) {
        await router.navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId: targetId, threadId: sandbox.threadId },
        });
      } else {
        await router.navigate({ to: "/", search: { environmentId: targetId } });
      }
    });
  const saveCredentials = () => {
    if (locked || tracked || !token.trim() || (provider === "modal" && !tokenId.trim())) return;
    void run({ scope: "account", label: `Checking ${providerName} credentials…` }, async () => {
      value(await configure({ environmentId, input: { provider, token, tokenId } }));
      setToken("");
      setTokenId("");
    });
  };
  const createSandbox = async () => {
    if (locked || !configured || !label.trim()) return;
    if (
      !(await requestConfirmDialog(
        `Create a remote sandbox on your ${providerName} account? Compute billing starts immediately. No agent prompt will be sent. Pause or delete it when finished.`,
      ))
    )
      return;
    await run(
      {
        scope: "create",
        label: "Creating the sandbox and installing Rove. This can take a few minutes.",
      },
      async () => {
        value(
          await create({
            environmentId,
            input: {
              provider,
              label: label.trim(),
              confirmCost: true,
              ...(newCredentials.length ? { credentials: newCredentials } : {}),
              ...(provider === "modal" && region !== "default" ? { region } : {}),
            },
          }),
        );
        setLabel("");
      },
    );
  };
  const pendingIn = (scope: string) =>
    pending?.scope === scope ? (
      <span role="status" className="text-muted-foreground">
        {pending.label}
      </span>
    ) : null;
  return (
    <>
      {!allowed ? (
        <SettingsRow
          title="Administrator access required"
          description="Pair this client with administrative access to manage remote sandboxes."
        />
      ) : null}
      <SettingsRow
        title="Provider"
        description={
          managedBy
            ? `Sandboxes are managed by ${managedBy}. Select another environment above to manage its own.`
            : "Run a thread on remote Linux compute. Work continues when this machine disconnects."
        }
        control={
          <div className="w-full @min-[32rem]/settings-row:w-40">
            <Select
              value={provider}
              disabled={locked}
              onValueChange={(next) => {
                if (next === "boat" || next === "modal") changeProvider(next);
              }}
            >
              <SelectTrigger size="sm" aria-label="Sandbox provider">
                <SelectValue>{providerName}</SelectValue>
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
          title={`${providerName} account`}
          description={
            tracked
              ? "Delete this account's sandboxes before removing or replacing its credentials."
              : "Verified and saved on this environment. Account credentials are never copied to sandboxes."
          }
          status={
            pendingIn("account") ??
            errorIn("account") ?? (
              <Badge variant="success" size="sm">
                Verified
              </Badge>
            )
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={locked || tracked}
              onClick={() =>
                void run({ scope: "account", label: "Removing credentials…" }, async () => {
                  value(await configure({ environmentId, input: { provider, token: "" } }));
                })
              }
            >
              Remove credentials
            </Button>
          }
        />
      ) : (
        <SettingsRow
          title={`${providerName} account`}
          description={
            provider === "boat"
              ? "Paste an API key from the Boat dashboard. Saving checks the key; it does not start compute."
              : "Paste a token ID (ak-…) and secret (as-…) from Modal settings. Saving checks them; it does not start compute."
          }
          status={pendingIn("account") ?? errorIn("account")}
          control={
            <form
              className="flex w-full flex-col gap-2 @min-[32rem]/settings-row:w-72"
              onSubmit={(event) => {
                event.preventDefault();
                saveCredentials();
              }}
            >
              {provider === "modal" ? (
                <Input
                  size="sm"
                  aria-label="Modal token ID"
                  placeholder="Token ID (ak-…)"
                  value={tokenId}
                  onChange={(event) => setTokenId(event.target.value)}
                  autoComplete="off"
                  disabled={locked}
                  required
                />
              ) : null}
              <div className="flex items-center gap-2">
                <Input
                  size="sm"
                  type="password"
                  aria-label={provider === "boat" ? "Boat API key" : "Modal token secret"}
                  placeholder={provider === "boat" ? "API key" : "Token secret (as-…)"}
                  value={token}
                  onChange={(event) => setToken(event.target.value)}
                  autoComplete="off"
                  disabled={locked}
                  required
                />
                <Button
                  size="sm"
                  variant="outline"
                  type="submit"
                  disabled={locked || !token.trim() || (provider === "modal" && !tokenId.trim())}
                >
                  Save
                </Button>
              </div>
            </form>
          }
        />
      )}
      <SettingsRow
        title="New sandbox"
        description={
          provider === "boat"
            ? "4 vCPU / 8 GB. Requires a paid Boat plan; trial accounts can't run sandboxes without auto-stop."
            : "2 cores / 8 GiB. Modal ends each run after 24 hours; pause before then to keep changes."
        }
        status={
          pendingIn("create") ??
          // A failure recorded on the new sandbox's row is shown there instead.
          errorIn(
            "create",
            inventory?.sandboxes.find((sandbox) => sandbox.detail === error?.label)?.detail,
          ) ??
          (!configured && inventory !== null ? (
            <span className="text-muted-foreground">Save {providerName} credentials first.</span>
          ) : null)
        }
        control={
          <form
            className="flex w-full items-center gap-2 @min-[32rem]/settings-row:w-72"
            onSubmit={(event) => {
              event.preventDefault();
              void createSandbox();
            }}
          >
            <Input
              size="sm"
              aria-label="Sandbox name"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              maxLength={80}
              placeholder="Sandbox name"
              disabled={locked || !configured}
              required
            />
            <Button size="sm" type="submit" disabled={locked || !configured || !label.trim()}>
              Create…
            </Button>
          </form>
        }
      >
        {availableCredentials ? (
          <div className="space-y-2 pt-2">
            <CredentialChoices
              available={availableCredentials}
              selected={newCredentials}
              disabled={locked || !configured}
              onChange={(kind, on) =>
                setNewCredentials((current) =>
                  on ? [...current, kind] : current.filter((value) => value !== kind),
                )
              }
            />
            {provider === "modal" ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span>Region</span>
                <Select
                  value={region}
                  disabled={locked || !configured}
                  onValueChange={(next) => {
                    if (next === "default" || next === "us" || next === "eu" || next === "ap")
                      setRegion(next);
                  }}
                >
                  <div className="w-44">
                    <SelectTrigger size="xs" aria-label="Sandbox region">
                      <SelectValue>{REGION_LABELS[region]}</SelectValue>
                    </SelectTrigger>
                  </div>
                  <SelectPopup>
                    {(["default", "us", "eu", "ap"] as const).map((option) => (
                      <SelectItem key={option} value={option}>
                        {REGION_LABELS[option]}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 pt-2 pb-2">
          <p className="max-w-xl text-xs leading-normal text-muted-foreground/80">
            {availableCredentials
              ? "Selected sign-ins are copied from this environment and refreshed on every resume. Pick the sandbox under Run on to clone a project there. Settling a thread doesn't stop billing; pause the sandbox when work finishes."
              : "Connect to open a blank thread, then clone a repository and sign in to a coding provider there. Settling a thread doesn't stop billing; pause the sandbox when work finishes."}
          </p>
          <Button
            size="xs"
            variant="ghost-muted"
            render={<a href={DASHBOARD_URLS[provider]} target="_blank" rel="noopener noreferrer" />}
          >
            {providerName} dashboard <ExternalLinkIcon />
          </Button>
        </div>
      </SettingsRow>
      <SettingsRow
        title="Sandboxes"
        description={
          inventory === null
            ? "Loading saved state…"
            : inventory.sandboxes.length === 0
              ? "No sandboxes yet."
              : "Pausing keeps files and conversations but interrupts running work."
        }
        status={errorIn("list")}
        control={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={locked}
            onClick={() => void run({ scope: "list", label: "Refreshing…" }, refresh)}
          >
            <RefreshCwIcon /> Refresh
          </Button>
        }
      />
      {inventory?.sandboxes.map((sandbox) => {
        const vendor = PROVIDER_NAMES[sandbox.provider];
        const rowPending = pendingIn(sandbox.id);
        const recoverable = sandbox.remoteId !== null && sandbox.phase !== "deleting";
        return (
          <SettingsRow
            key={sandbox.id}
            title={<span className="break-words [overflow-wrap:anywhere]">{sandbox.label}</span>}
            description={
              sandbox.threadId
                ? `${vendor} · Thread linked`
                : sandbox.phase === "running"
                  ? `${vendor} · Ready to connect`
                  : vendor
            }
            status={
              rowPending ?? (
                <Badge
                  size="sm"
                  variant={
                    sandbox.phase === "error"
                      ? "error"
                      : sandbox.phase === "running"
                        ? "success"
                        : sandbox.phase === "creating" || sandbox.phase === "deleting"
                          ? "info"
                          : "secondary"
                  }
                >
                  {PHASE_LABELS[sandbox.phase]}
                </Badge>
              )
            }
            control={
              <>
                {sandbox.phase === "running" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={locked}
                    onClick={() => void open(sandbox)}
                  >
                    {sandbox.threadId ? "Open thread" : "Connect"}
                  </Button>
                ) : sandbox.phase === "paused" ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={locked}
                    onClick={() => void operate(sandbox, "resume")}
                  >
                    Resume…
                  </Button>
                ) : null}
                <Menu>
                  <MenuTrigger
                    render={
                      <Button
                        size="xs"
                        variant="outline"
                        disabled={locked}
                        aria-label={`Actions for ${sandbox.label}`}
                      />
                    }
                  >
                    Actions <ChevronDownIcon />
                  </MenuTrigger>
                  <MenuPopup align="end">
                    {sandbox.phase === "running" ? (
                      <MenuItem onClick={() => void operate(sandbox, "pause")}>
                        Pause sandbox…
                      </MenuItem>
                    ) : sandbox.phase === "paused" ? (
                      <MenuItem onClick={() => void operate(sandbox, "resume")}>
                        Resume sandbox…
                      </MenuItem>
                    ) : (
                      <MenuItem
                        disabled={!recoverable}
                        onClick={() => void operate(sandbox, "resume")}
                      >
                        Repair sandbox…
                      </MenuItem>
                    )}
                    <MenuItem
                      render={
                        <a
                          href={DASHBOARD_URLS[sandbox.provider]}
                          target="_blank"
                          rel="noopener noreferrer"
                        />
                      }
                    >
                      Open {vendor} dashboard <ExternalLinkIcon />
                    </MenuItem>
                    <MenuSeparator />
                    <MenuItem variant="destructive" onClick={() => void operate(sandbox, "delete")}>
                      Delete sandbox…
                    </MenuItem>
                    {sandbox.phase === "error" || sandbox.phase === "deleting" ? (
                      <MenuItem variant="destructive" onClick={() => void forget(sandbox)}>
                        Forget record…
                      </MenuItem>
                    ) : null}
                  </MenuPopup>
                </Menu>
              </>
            }
          >
            {availableCredentials && (sandbox.phase === "running" || sandbox.phase === "paused") ? (
              <div className="pt-2 pb-2">
                <CredentialChoices
                  available={availableCredentials}
                  selected={sandbox.credentials ?? []}
                  disabled={locked}
                  onChange={(kind, on) => changeCredentials(sandbox, kind, on)}
                />
              </div>
            ) : null}
            {sandbox.detail || sandbox.phase === "error" || errorIn(sandbox.id, sandbox.detail) ? (
              <div className="space-y-1 pt-2 pb-2">
                {errorIn(sandbox.id, sandbox.detail)}
                {sandbox.detail ? <SandboxErrorMessage message={sandbox.detail} /> : null}
                {sandbox.phase === "error" ? (
                  <p className="text-xs leading-normal text-muted-foreground/80">
                    It may still be billing. Repair it, delete it, or check the {vendor} dashboard.
                  </p>
                ) : null}
              </div>
            ) : null}
          </SettingsRow>
        );
      })}
    </>
  );
}

/** Sign-ins found on the managing environment, plus any still forwarded after a local sign-out. */
function CredentialChoices({
  available,
  selected,
  disabled,
  onChange,
}: {
  available: ReadonlyArray<SandboxCredentialKind>;
  selected: ReadonlyArray<SandboxCredentialKind>;
  disabled: boolean;
  onChange: (kind: SandboxCredentialKind, on: boolean) => void;
}) {
  const kinds = (Object.keys(CREDENTIAL_NAMES) as Array<SandboxCredentialKind>).filter(
    (kind) => available.includes(kind) || selected.includes(kind),
  );
  if (kinds.length === 0)
    return (
      <p className="text-xs text-muted-foreground/80">
        Sign in to Codex, Claude, Pi, OpenCode, or GitHub on this environment to forward it.
      </p>
    );
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-muted-foreground">
      <span>Forward sign-ins</span>
      {kinds.map((kind) => (
        <label key={kind} className="flex cursor-pointer items-center gap-1.5">
          <Checkbox
            aria-label={`Forward ${CREDENTIAL_NAMES[kind]} sign-in`}
            checked={selected.includes(kind)}
            disabled={disabled}
            onCheckedChange={(checked) => onChange(kind, checked === true)}
          />
          <span className="text-foreground">{CREDENTIAL_NAMES[kind]}</span>
        </label>
      ))}
    </div>
  );
}

function SandboxErrorMessage({ message }: { message: string }) {
  return (
    <div role="alert" className="flex items-start gap-2">
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
