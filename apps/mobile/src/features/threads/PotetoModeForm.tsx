import { validatePotetoProjectSpecJson } from "@rove-code/client-runtime/poteto";
import type {
  EnvironmentId,
  ModelSelection,
  PotetoProjectSpec,
  ThreadId,
} from "@rove-code/contracts";
import { collectComposerContextReferences } from "@rove-code/shared/composerContextReferences";
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, View } from "react-native";
import { AppText } from "../../components/AppText";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { requirePotetoCommandSuccess } from "./poteto-submission";

export interface PotetoModeFormProps {
  readonly visible: boolean;
  readonly description: string;
  readonly hasAttachments: boolean;
  readonly hasContext: boolean;
  readonly environmentId: EnvironmentId;
  readonly modelSelection: ModelSelection;
  readonly getThreadId: () => Promise<ThreadId>;
  readonly onClose: () => void;
  readonly onStart: (
    spec: PotetoProjectSpec,
    description: string,
    modelSelection: ModelSelection,
  ) => Promise<boolean>;
}

/** Mount for one composer submission; its prompt, target and model stay frozen until closed. */
export function PotetoModeForm(props: PotetoModeFormProps) {
  const draft = useAtomCommand(serverEnvironment.potetoDraft, { reportFailure: false });
  const [source] = useState(() => props);
  const [spec, setSpec] = useState<PotetoProjectSpec | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const approving = useRef(false);
  const request = useRef<Promise<Awaited<ReturnType<typeof draft>>> | null>(null);

  useEffect(() => {
    if (!props.visible) return;
    let cancelled = false;
    setSpec(null);
    setError(null);
    if (
      source.hasAttachments ||
      source.hasContext ||
      collectComposerContextReferences(source.description).length > 0
    ) {
      setBusy(false);
      setError("Poteto drafts are text-only. Remove attachments and context before drafting.");
      return;
    }
    const description = source.description.trim();
    if (!description || description.length > 4096) {
      setBusy(false);
      setError("Describe the task in the composer first (up to 4096 characters).");
      return;
    }
    setBusy(true);
    // Cache the entire preparation, not just the RPC: StrictMode can replay this effect
    // while a new thread's creation is still in flight.
    request.current ??= (async () => {
      const threadId = await source.getThreadId();
      return draft({
        environmentId: source.environmentId,
        input: { threadId, description, modelSelection: source.modelSelection },
      });
    })();
    const drafting = request.current;
    void (async () => {
      try {
        const result = await drafting;
        if (cancelled) return;
        requirePotetoCommandSuccess(result);
        if (result._tag !== "Success") return;
        if (result.value.status === "unsupported") {
          setError(result.value.reason);
        } else {
          const validation = validatePotetoProjectSpecJson(JSON.stringify(result.value.spec));
          if (validation.valid) setSpec(validation.spec);
          else setError(validation.errors.join("\n"));
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Could not draft a proposal.");
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [props.visible, draft, source]);

  const close = () => {
    if (!approving.current) source.onClose();
  };
  const start = async () => {
    if (!spec || busy || approving.current) return;
    const validation = validatePotetoProjectSpecJson(JSON.stringify(spec));
    if (!validation.valid) {
      setError(validation.errors.join("\n"));
      return;
    }
    approving.current = true;
    setBusy(true);
    setError(null);
    try {
      const started = await source.onStart(
        validation.spec,
        source.description,
        source.modelSelection,
      );
      if (started) source.onClose();
      else setError("Could not start Poteto Mode. Try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start Poteto Mode.");
    } finally {
      approving.current = false;
      setBusy(false);
    }
  };

  return (
    <Modal
      visible={props.visible}
      animationType="none"
      presentationStyle="pageSheet"
      onRequestClose={close}
    >
      <ScrollView className="flex-1 bg-sheet" contentContainerClassName="gap-4 px-5 pb-8 pt-8">
        <AppText accessibilityRole="header" className="text-xl font-rove-semibold">
          Poteto Mode
        </AppText>
        <AppText className="text-sm text-foreground-secondary">
          Review the proposed task, file scope, and checks before starting.
        </AppText>
        {busy && !spec ? <AppText>Drafting proposal…</AppText> : null}
        {error ? (
          <AppText accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error}
          </AppText>
        ) : null}
        {spec ? (
          <AppText selectable className="font-mono text-xs leading-5">
            {JSON.stringify(spec, null, 2)}
          </AppText>
        ) : null}
        <AppText className="text-sm text-foreground-muted">
          Uses {source.modelSelection.model}. Runs from committed HEAD in an isolated Docker
          candidate. Docker must be available on the host. The candidate is never applied
          automatically.
        </AppText>
        <View className="flex-row justify-end gap-3 pt-2">
          <Pressable
            accessibilityRole="button"
            disabled={busy && !!spec}
            className="min-h-12 justify-center px-3"
            onPress={close}
          >
            <AppText className="font-rove-medium">{spec ? "Refine in composer" : "Close"}</AppText>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Approve and start"
            accessibilityState={{ disabled: !spec || busy }}
            disabled={!spec || busy}
            className="min-h-12 justify-center rounded-xl bg-primary px-4 disabled:opacity-50"
            onPress={() => void start()}
          >
            <AppText className="font-rove-semibold text-primary-foreground">
              {busy && spec ? "Starting…" : "Approve and start"}
            </AppText>
          </Pressable>
        </View>
      </ScrollView>
    </Modal>
  );
}
