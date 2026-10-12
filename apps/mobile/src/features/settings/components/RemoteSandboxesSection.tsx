import { useNavigation } from "@react-navigation/native";
import {
  ThreadId,
  type EnvironmentId,
  type RemoteSandbox,
  type SandboxInventory,
  type SandboxProvider,
} from "@rove-code/contracts";
import {
  standaloneThreadInput,
  supportsStandaloneThreads,
} from "@rove-code/client-runtime/state/standalone-thread";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@rove-code/client-runtime/state/runtime";
import { useEffect, useRef, useState } from "react";
import { Alert, TextInput, View } from "react-native";
import { AppText as Text } from "../../../components/AppText";
import { environmentCatalog } from "../../../connection/catalog";
import { connectPairingUrl } from "../../../connection/onboarding";
import { uuidv4 } from "../../../lib/uuid";
import { sandboxEnvironment } from "../../../state/sandbox";
import { threadEnvironment } from "../../../state/threads";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsActionRow } from "./SettingsActionRow";
import { SettingsSection } from "./SettingsSection";

function value<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  return result.value;
}

export function RemoteSandboxesSection({
  environmentId,
  allowed,
}: {
  environmentId: EnvironmentId;
  allowed: boolean;
}) {
  const navigation = useNavigation();
  const inventoryCommand = useAtomCommand(sandboxEnvironment.inventory, { reportFailure: false });
  const configure = useAtomCommand(sandboxEnvironment.configure, { reportFailure: false });
  const create = useAtomCommand(sandboxEnvironment.create, { reportFailure: false });
  const action = useAtomCommand(sandboxEnvironment.action, { reportFailure: false });
  const link = useAtomCommand(sandboxEnvironment.link, { reportFailure: false });
  const getConfig = useAtomCommand(sandboxEnvironment.getConfig, { reportFailure: false });
  const pair = useAtomCommand(connectPairingUrl, { reportFailure: false });
  const createThread = useAtomCommand(threadEnvironment.create, { reportFailure: false });
  const removeEnvironment = useAtomCommand(environmentCatalog.remove, { reportFailure: false });
  const [inventory, setInventory] = useState<SandboxInventory | null>(null);
  const [provider, setProvider] = useState<SandboxProvider>("boat");
  const [tokenId, setTokenId] = useState("");
  const [token, setToken] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void inventoryCommand({ environmentId, input: {} }).then((result) => {
      if (!active) return;
      if (result._tag === "Failure") {
        setError("Could not read sandbox configuration.");
        return;
      }
      setInventory(result.value);
      // Open on the account already in use rather than always on Boat.
      setProvider(
        result.value.sandboxes[0]?.provider ?? result.value.configuredProviders[0] ?? "boat",
      );
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
  const confirm = (
    title: string,
    message: string,
    work: () => Promise<void>,
    destructive = false,
  ) =>
    Alert.alert(title, message, [
      { text: "Cancel", style: "cancel" },
      {
        text: destructive ? "Delete" : "Continue",
        style: destructive ? "destructive" : "default",
        onPress: () => void run(work),
      },
    ]);
  const configured = inventory?.configuredProviders.includes(provider) ?? false;
  const tracked = inventory?.sandboxes.some((sandbox) => sandbox.provider === provider) ?? false;
  const disabled = !allowed || busy;
  const open = (sandbox: RemoteSandbox) =>
    void run(async () => {
      const result = value(
        await action({ environmentId, input: { id: sandbox.id, action: "pair", confirmed: true } }),
      );
      if (!result.pairingUrl) throw new Error("Pairing URL is unavailable.");
      const targetId = value(await pair(result.pairingUrl));
      const config = value(await getConfig({ environmentId: targetId, input: {} }));
      if (!supportsStandaloneThreads(config))
        throw new Error("Update Rove in the sandbox before creating a thread.");
      if (sandbox.environmentId !== null && sandbox.environmentId !== targetId)
        throw new Error("Sandbox identity changed; existing thread was not replaced.");
      const threadId = sandbox.threadId ?? ThreadId.make(uuidv4());
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
      navigation.navigate("Thread", { environmentId: targetId, threadId });
    });
  return (
    <SettingsSection title="Remote sandboxes · Preview">
      <View className="gap-3 p-4">
        <Text className="text-sm text-foreground-muted">
          One remote Linux environment per thread. Bring your own Boat or Modal account; compute and
          storage may be billed. No model credentials or repositories are uploaded automatically.
          Pause manually after settling; pausing interrupts running work. Transcript access requires
          running compute.
        </Text>
        <Text className="text-sm text-foreground">
          {provider === "boat"
            ? "Boat: 4 vCPU / 8 GB. Requires a paid Boat plan."
            : "Modal: 2 cores / 8 GiB. Modal ends each run after 24 hours; pause before then to keep changes. Snapshots may cost extra."}
        </Text>
        <Text className="text-sm text-foreground-muted">
          Credentials: {configured ? "verified" : "not configured"}. Saving checks them but does not
          start compute. Delete tracked sandboxes before changing accounts.
        </Text>
        {provider === "modal" ? (
          <TextInput
            accessibilityLabel="Modal token ID"
            placeholder="Modal token ID"
            value={tokenId}
            onChangeText={setTokenId}
            autoCapitalize="none"
            autoCorrect={false}
            editable={!disabled && !tracked}
            className="rounded-lg bg-background px-3 py-2 text-foreground"
          />
        ) : null}
        <TextInput
          accessibilityLabel={provider === "boat" ? "Boat API key" : "Modal token secret"}
          placeholder={provider === "boat" ? "Boat API key" : "Modal token secret"}
          value={token}
          onChangeText={setToken}
          secureTextEntry
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled && !tracked}
          className="rounded-lg bg-background px-3 py-2 text-foreground"
        />
        <TextInput
          accessibilityLabel="Thread sandbox name"
          placeholder="Thread sandbox name"
          value={label}
          onChangeText={setLabel}
          maxLength={80}
          editable={!disabled}
          className="rounded-lg bg-background px-3 py-2 text-foreground"
        />
        {error ? (
          <Text accessibilityRole="alert" selectable className="text-sm text-danger-foreground">
            {error}
          </Text>
        ) : null}
        {busy ? (
          <Text className="text-sm text-foreground-muted">Working on the sandbox…</Text>
        ) : null}
      </View>
      <SettingsActionRow
        icon="server.rack"
        label={`Provider: ${provider === "boat" ? "Boat" : "Modal"}`}
        disabled={disabled}
        onPress={() => {
          setProvider(provider === "boat" ? "modal" : "boat");
          setToken("");
          setTokenId("");
        }}
      />
      <SettingsActionRow
        icon="gearshape"
        label="Save credentials"
        disabled={disabled || tracked || !token.trim() || (provider === "modal" && !tokenId.trim())}
        onPress={() =>
          void run(async () => {
            value(
              await configure({
                environmentId,
                input: { provider, token, tokenId },
              }),
            );
            setToken("");
            setTokenId("");
          })
        }
      />
      {configured ? (
        <SettingsActionRow
          icon="gearshape"
          label="Remove credentials"
          disabled={disabled || tracked}
          onPress={() =>
            void run(async () => {
              value(await configure({ environmentId, input: { provider, token: "" } }));
            })
          }
        />
      ) : null}
      <SettingsActionRow
        icon="plus"
        label="Create sandbox…"
        disabled={disabled || !configured || !label.trim()}
        onPress={() =>
          confirm(
            "Start billed compute?",
            `Create a sandbox on your ${provider} account? No agent prompt is sent. Pause or delete when finished.`,
            async () => {
              value(
                await create({
                  environmentId,
                  input: { provider, label: label.trim(), confirmCost: true },
                }),
              );
              setLabel("");
            },
          )
        }
      />
      {inventory?.sandboxes.map((sandbox) => (
        <View key={sandbox.id}>
          <View className="gap-1 px-4 pt-4">
            <Text className="text-base text-foreground">{sandbox.label}</Text>
            <Text className="text-sm text-foreground-muted">
              {sandbox.provider} · {sandbox.phase}
              {sandbox.phase === "error" ? " (may still be billing)" : ""} ·{" "}
              {sandbox.remoteId ?? "Unknown resource ID"}
            </Text>
            {sandbox.detail ? (
              <Text selectable className="text-sm text-danger-foreground">
                {sandbox.detail}
              </Text>
            ) : null}
          </View>
          <SettingsActionRow
            icon="arrow.up.right"
            label={sandbox.threadId ? "Open thread" : "Connect & create blank thread"}
            disabled={disabled || sandbox.phase !== "running"}
            onPress={() => open(sandbox)}
          />
          <SettingsActionRow
            icon={sandbox.phase === "running" ? "stop.fill" : "play"}
            label={sandbox.phase === "running" ? "Pause…" : "Resume / repair…"}
            disabled={disabled || !sandbox.remoteId}
            onPress={() => {
              const kind = sandbox.phase === "running" ? "pause" : "resume";
              confirm(
                kind === "pause" ? "Pause sandbox?" : "Start billed compute?",
                kind === "pause"
                  ? "This stops Rove and interrupts agents, builds, and terminals. Files and persisted conversations are retained."
                  : "Resuming starts compute billing on your account.",
                async () => {
                  value(
                    await action({
                      environmentId,
                      input: { id: sandbox.id, action: kind, confirmed: true },
                    }),
                  );
                },
              );
            }}
          />
          <SettingsActionRow
            icon="trash"
            label="Delete permanently…"
            tone="danger"
            disabled={disabled}
            onPress={() =>
              confirm(
                "Delete sandbox permanently?",
                "Workspace, credentials, and recovery snapshots will be deleted. This cannot be undone. If provisioning returned no resource ID, verify and clean up resources in the vendor dashboard first.",
                async () => {
                  value(
                    await action({
                      environmentId,
                      input: { id: sandbox.id, action: "delete", confirmed: true },
                    }),
                  );
                  // Connecting saved the sandbox as an environment; drop it too.
                  if (sandbox.environmentId) await removeEnvironment(sandbox.environmentId);
                },
                true,
              )
            }
          />
          {sandbox.phase === "error" || sandbox.phase === "deleting" ? (
            <SettingsActionRow
              icon="trash"
              label="Forget failed record…"
              tone="danger"
              disabled={disabled}
              onPress={() =>
                confirm(
                  "Forget record only?",
                  "This does NOT stop billing or delete vendor resources. Verify cleanup in the vendor dashboard first. Saved recovery handles will be lost.",
                  async () => {
                    value(
                      await action({
                        environmentId,
                        input: { id: sandbox.id, action: "forget", confirmed: true },
                      }),
                    );
                    if (sandbox.environmentId) await removeEnvironment(sandbox.environmentId);
                  },
                  true,
                )
              }
            />
          ) : null}
        </View>
      ))}
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Refresh saved state"
        disabled={disabled}
        onPress={() => void run(refresh)}
      />
    </SettingsSection>
  );
}
