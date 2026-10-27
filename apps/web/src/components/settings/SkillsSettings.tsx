import { useAtomValue } from "@effect/atom-react";
import { connectionStatusTitle } from "@getpaperplane/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@getpaperplane/client-runtime/state/runtime";
import type { AgentSkillsStatus, EnvironmentId } from "@getpaperplane/contracts";
import { resolveEnvironmentMachineKind } from "@getpaperplane/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { formatRelativeTimeLabel } from "../../timestampFormat";
import { type EnvironmentPresentation } from "../../state/environments";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot, connectionPhaseDotClassName } from "../ConnectionStatusDot";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { EnvironmentRow, environmentTransportLabel } from "./EnvironmentRow";
import { SettingsGroup } from "./SettingsGroup";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
  useRelativeTimeTick,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { settingsScopeEnvironmentLabel } from "./settingsScopeAxis";
import {
  buildSkillMatrix,
  canSyncAgentSkills,
  filterSkillMatrixRows,
  gitStatusLabel,
  type GitStatusTone,
  type SkillCellState,
} from "./skillsSettings.logic";

const CELL_BADGE = {
  present: { label: "Present", variant: "success" },
  different: { label: "Different", variant: "warning" },
  missing: { label: "Missing", variant: "outline" },
} as const satisfies Record<SkillCellState, { label: string; variant: string }>;

const GIT_TONE_CLASS = {
  neutral: "text-muted-foreground",
  warning: "text-warning-foreground",
  destructive: "text-destructive",
} as const satisfies Record<GitStatusTone, string>;

const DEFAULT_DIRECTORY_LABEL = "~/.agents/skills";

/** The repo's presentation of a failed command: its message, never the raw error class. */
function commandErrorMessage(result: { readonly cause: Cause.Cause<unknown> }): string {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Something went wrong.";
}

function isConnected(environment: EnvironmentPresentation): boolean {
  return environment.connection.phase === "connected" && environment.serverConfig !== null;
}

/**
 * Every connected environment's skill status, read in one atom so the number
 * of environments can change without adding hooks in a loop.
 */
const skillStatusesAtom = (
  environments: ReadonlyArray<EnvironmentPresentation>,
): Atom.Atom<
  ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly status: AgentSkillsStatus | null;
    readonly error: string | null;
  }>
> =>
  Atom.make((get) =>
    environments.map((environment) => {
      if (!isConnected(environment)) {
        return { environmentId: environment.environmentId, status: null, error: null };
      }
      const query = get(
        serverEnvironment.agentSkillsStatus({
          environmentId: environment.environmentId,
          input: {},
        }),
      );
      return {
        environmentId: environment.environmentId,
        status: Option.getOrNull(AsyncResult.value(query)),
        error: query._tag === "Failure" ? formatEnvironmentQueryError(query.cause) : null,
      };
    }),
  );

export function SkillsSettings() {
  const { scope, environments } = useSettingsScope();
  useRelativeTimeTick(60_000);

  return (
    <SettingsPageContainer>
      {scope.kind === "unavailable" ? (
        <SettingsSection title="Unavailable selection">
          <SettingsRow title={scope.message} />
        </SettingsSection>
      ) : environments.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <SparklesIcon />
            </EmptyMedia>
            <EmptyTitle>No environments available</EmptyTitle>
            <EmptyDescription>Connect an environment to manage its agent skills.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <SettingsSection title="Agent skills">
            <SettingsGroup>
              <SettingsRow
                title="Shared skills folder"
                description="Each environment keeps its skills in ~/.agents/skills. Every provider on that machine reads this folder."
              />
              {environments.map((environment) => (
                <SkillsEnvironmentCard
                  key={environment.environmentId}
                  environment={environment}
                  showLabel={environments.length > 1}
                />
              ))}
            </SettingsGroup>
          </SettingsSection>
          {environments.filter(isConnected).length >= 2 ? (
            <SkillsMatrix environments={environments} />
          ) : null}
        </>
      )}
    </SettingsPageContainer>
  );
}

function SkillsEnvironmentCard({
  environment,
  showLabel,
}: {
  readonly environment: EnvironmentPresentation;
  readonly showLabel: boolean;
}) {
  const { environments } = useSettingsScope();
  const connected = isConnected(environment);
  const statusQuery = useEnvironmentQuery(
    connected
      ? serverEnvironment.agentSkillsStatus({
          environmentId: environment.environmentId,
          input: {},
        })
      : null,
  );
  const [setupOpen, setSetupOpen] = useState(false);
  // One pending action at a time per card: any pending action disables the others.
  const [pending, setPending] = useState<"sync" | "check" | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);
  const canSetUp = useAtomValue(
    serverEnvironment.initAgentSkillsRepository.permissionAtom(environment.environmentId),
  );
  const canSync = useAtomValue(
    serverEnvironment.syncAgentSkills.permissionAtom(environment.environmentId),
  );
  const canCheck = useAtomValue(
    serverEnvironment.checkAgentSkillsUpdates.permissionAtom(environment.environmentId),
  );
  const initRepository = useAtomCommand(serverEnvironment.initAgentSkillsRepository, {
    label: "agent skills init repository",
    reportFailure: false,
  });
  const syncSkills = useAtomCommand(serverEnvironment.syncAgentSkills, {
    label: "agent skills sync",
    reportFailure: false,
  });
  const checkUpdates = useAtomCommand(serverEnvironment.checkAgentSkillsUpdates, {
    label: "agent skills check updates",
    reportFailure: false,
  });

  const status = statusQuery.data ?? null;
  const label = settingsScopeEnvironmentLabel(environment, environments);
  const transport = environmentTransportLabel(environment);
  const git = status?.git ?? null;
  const gitLine = status ? gitStatusLabel(status) : null;

  const runSync = async () => {
    setPending("sync");
    setCommandError(null);
    const result = await syncSkills({ environmentId: environment.environmentId, input: undefined });
    setPending(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setCommandError(commandErrorMessage(result));
    }
  };

  const runCheck = async () => {
    setPending("check");
    setCommandError(null);
    const result = await checkUpdates({
      environmentId: environment.environmentId,
      input: { fetch: true },
    });
    setPending(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setCommandError(commandErrorMessage(result));
    }
  };

  return (
    <div className="divide-y divide-border/50">
      <EnvironmentRow
        kind={resolveEnvironmentMachineKind(environment.serverConfig)}
        label={showLabel ? label : "This environment"}
        subtitle={
          <>
            <span className="block truncate">{status?.directory ?? DEFAULT_DIRECTORY_LABEL}</span>
            <span className="block truncate">{transport}</span>
          </>
        }
        below={
          <div className="space-y-1 text-xs text-muted-foreground">
            {!connected ? (
              <span className="block">Reconnect {label} to manage its skills.</span>
            ) : statusQuery.error ? (
              <span className="block text-destructive">{statusQuery.error}</span>
            ) : !status ? (
              <span className="block" role="status">
                Loading skills…
              </span>
            ) : status.exists === false ? (
              <span className="block">
                No skills folder yet. Providers read ~/.agents/skills; create it with &ldquo;Set up
                repository&rdquo;, or add skill folders there yourself.
              </span>
            ) : (
              <>
                <span className="block">
                  {status.skills.length} skill{status.skills.length === 1 ? "" : "s"}
                  {gitLine ? (
                    <>
                      {" · "}
                      <span className={GIT_TONE_CLASS[gitLine.tone]}>{gitLine.text}</span>
                    </>
                  ) : null}
                </span>
                {git?.lastFetchedAt ? (
                  <span className="block">
                    Last checked {formatRelativeTimeLabel(git.lastFetchedAt)}
                  </span>
                ) : null}
                {git?.lastError ? (
                  <span className="block text-destructive">{git.lastError}</span>
                ) : null}
              </>
            )}
            {commandError ? (
              <span className="block text-destructive" role="alert">
                {commandError}
              </span>
            ) : null}
          </div>
        }
      >
        <ConnectionStatusDot
          dotClassName={connectionPhaseDotClassName(environment.connection.phase)}
          tooltipText={connectionStatusTitle(environment.connection)}
        />
        {connected && status ? (
          git === null ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canSetUp}
              onClick={() => setSetupOpen(true)}
            >
              Set up repository
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!canCheck || pending !== null}
                onClick={() => void runCheck()}
              >
                {pending === "check" ? "Checking…" : "Check for updates"}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={!canSync || pending !== null || !canSyncAgentSkills(status)}
                onClick={() => void runSync()}
              >
                {pending === "sync" ? "Syncing…" : "Sync"}
              </Button>
            </div>
          )
        ) : null}
      </EnvironmentRow>
      {setupOpen ? (
        <SetupRepositoryDialog
          directory={status?.directory ?? DEFAULT_DIRECTORY_LABEL}
          onSubmit={async (remoteUrl) => {
            const result = await initRepository({
              environmentId: environment.environmentId,
              input: remoteUrl === null ? {} : { remoteUrl },
            });
            if (result._tag === "Failure") {
              return isAtomCommandInterrupted(result) ? null : commandErrorMessage(result);
            }
            setCommandError(null);
            setSetupOpen(false);
            return null;
          }}
          onClose={() => setSetupOpen(false)}
        />
      ) : null}
    </div>
  );
}

function SetupRepositoryDialog({
  directory,
  onSubmit,
  onClose,
}: {
  readonly directory: string;
  readonly onSubmit: (remoteUrl: string | null) => Promise<string | null>;
  readonly onClose: () => void;
}) {
  const [remoteUrl, setRemoteUrl] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(null);
    const trimmed = remoteUrl.trim();
    const failure = await onSubmit(trimmed === "" ? null : trimmed);
    setSaving(false);
    if (failure !== null) setError(failure);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup
        className="max-w-md"
        showCloseButton={!saving}
        render={<form onSubmit={submit} />}
      >
        <DialogHeader>
          <DialogTitle>Set up skills repository</DialogTitle>
          <DialogDescription>
            Create a git repository for {directory} so its skills can be shared and synced.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="agent-skills-remote">Remote URL</Label>
              <Input
                id="agent-skills-remote"
                placeholder="git@github.com:you/agent-skills.git"
                value={remoteUrl}
                disabled={saving}
                onChange={(event) => setRemoteUrl(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Use a private repository. If it already holds skills from another machine, they are
                merged in and the remote copy wins where a skill differs. Leave blank to track
                changes on this machine only.
              </p>
            </div>
            {error ? <p className="text-sm text-destructive">{error}</p> : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
            Cancel
          </DialogClose>
          <Button type="submit" size="sm" disabled={saving}>
            {saving ? "Setting up…" : "Set up"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function SkillsMatrix({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
  const { environments: allEnvironments } = useSettingsScope();
  const [onlyDifferences, setOnlyDifferences] = useState(false);
  const statusesAtom = useMemo(() => skillStatusesAtom(environments), [environments]);
  const statuses = useAtomValue(statusesAtom);
  const columns = environments.map((environment) => ({
    environmentId: environment.environmentId,
    label: settingsScopeEnvironmentLabel(environment, allEnvironments),
  }));
  const rows = useMemo(
    () =>
      buildSkillMatrix(
        statuses.map(({ environmentId, status }) => ({
          environmentId,
          skills: status?.skills ?? null,
        })),
      ),
    [statuses],
  );
  const visibleRows = filterSkillMatrixRows(rows, onlyDifferences);

  return (
    <SettingsSection
      title="Compare environments"
      headerAction={
        <Button size="xs" variant="ghost-muted" onClick={() => setOnlyDifferences((v) => !v)}>
          {onlyDifferences ? "Show all" : "Only differences"}
        </Button>
      }
    >
      <SettingsGroup>
        <div className="overflow-x-auto px-3 py-2.5 sm:px-4">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Skill</TableHead>
                {columns.map((column) => (
                  <TableHead key={column.environmentId}>{column.label}</TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleRows.map((row) => (
                <TableRow key={row.name}>
                  <TableCell>
                    <div className="font-medium">{row.name}</div>
                    {row.description ? (
                      <div className="text-xs text-muted-foreground">{row.description}</div>
                    ) : null}
                  </TableCell>
                  {row.cells.map((cell, index) => (
                    <TableCell key={columns[index]!.environmentId}>
                      {cell === null ? (
                        <span className="text-xs text-muted-foreground">Unavailable</span>
                      ) : (
                        <Badge variant={CELL_BADGE[cell].variant}>{CELL_BADGE[cell].label}</Badge>
                      )}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {visibleRows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground" role="status">
              {onlyDifferences
                ? "Every skill matches across environments."
                : "No skills in any environment yet."}
            </p>
          ) : null}
        </div>
      </SettingsGroup>
    </SettingsSection>
  );
}
