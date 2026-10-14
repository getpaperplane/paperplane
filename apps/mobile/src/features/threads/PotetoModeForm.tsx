import {
  POTETO_PROJECT_SPEC_EXAMPLE,
  validatePotetoProjectSpecJson,
} from "@rove-code/client-runtime/poteto";
import type { PotetoProjectSpec } from "@rove-code/contracts";
import { useMemo, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";
import { AppText, AppTextInput } from "../../components/AppText";

export function PotetoModeForm(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onStart: (spec: PotetoProjectSpec) => Promise<boolean>;
}) {
  const [specJson, setSpecJson] = useState(POTETO_PROJECT_SPEC_EXAMPLE);
  const [submitting, setSubmitting] = useState(false);
  const validation = useMemo(() => validatePotetoProjectSpecJson(specJson), [specJson]);

  const start = async () => {
    if (!validation.valid || submitting) return;
    setSubmitting(true);
    try {
      const started = await props.onStart(validation.spec);
      if (started) props.onClose();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      visible={props.visible}
      animationType="none"
      presentationStyle="pageSheet"
      onRequestClose={() => {
        if (!submitting) props.onClose();
      }}
    >
      <KeyboardAvoidingView
        className="flex-1 bg-sheet"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          className="flex-1"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="gap-4 px-5 pb-8 pt-8"
        >
          <AppText accessibilityRole="header" className="text-xl font-rove-semibold">
            Poteto Mode
          </AppText>
          <AppText className="text-sm text-foreground-secondary">
            Define the task, committed file scope, and dependency-free JavaScript or TypeScript
            checks.
          </AppText>
          <AppText accessibilityRole="text" className="text-sm font-rove-medium">
            Project spec (JSON)
          </AppText>
          <AppTextInput
            accessibilityLabel="Project spec JSON"
            autoCapitalize="none"
            autoCorrect={false}
            multiline
            spellCheck={false}
            textAlignVertical="top"
            value={specJson}
            onChangeText={setSpecJson}
            className="min-h-64 rounded-xl font-mono text-xs leading-5"
          />
          {!validation.valid ? (
            <View accessibilityRole="alert" className="gap-1">
              {validation.errors.map((error) => (
                <AppText key={error} className="text-sm text-danger-foreground">
                  {error}
                </AppText>
              ))}
            </View>
          ) : null}
          <AppText className="text-sm text-foreground-muted">
            Runs from committed HEAD in an isolated Docker candidate. Docker must be available on
            the host. The candidate is never applied automatically.
          </AppText>
          <View className="flex-row justify-end gap-3 pt-2">
            <Pressable
              accessibilityRole="button"
              className="min-h-12 justify-center px-3"
              disabled={submitting}
              onPress={props.onClose}
            >
              <AppText className="font-rove-medium">Cancel</AppText>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !validation.valid || submitting }}
              className="min-h-12 justify-center rounded-xl bg-primary px-4 disabled:opacity-50"
              disabled={!validation.valid || submitting}
              onPress={() => void start()}
            >
              <AppText className="font-rove-semibold text-primary-foreground">
                {submitting ? "Starting…" : "Start Poteto Mode"}
              </AppText>
            </Pressable>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
  );
}
