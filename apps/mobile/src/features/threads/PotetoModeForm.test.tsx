import { StrictMode } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
  type PotetoDraftResult,
} from "@rove-code/contracts";
import type { AtomCommandResult } from "@rove-code/client-runtime/state/runtime";
import {
  POTETO_PROJECT_SPEC_EXAMPLE,
  validatePotetoProjectSpecJson,
} from "@rove-code/client-runtime/poteto";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";

const commands = vi.hoisted(() => ({
  draft:
    vi.fn<
      (value: {
        environmentId: EnvironmentId;
        input: { threadId: ThreadId; description: string; modelSelection: ModelSelection };
      }) => Promise<AtomCommandResult<PotetoDraftResult, unknown>>
    >(),
}));
vi.mock("react-native", () => ({
  Modal: "dialog",
  Pressable: "button",
  ScrollView: "section",
  View: "div",
}));
vi.mock("../../components/AppText", () => ({ AppText: "span" }));
vi.mock("../../state/server", () => ({ serverEnvironment: { potetoDraft: {} } }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => commands.draft }));

import { PotetoModeForm, type PotetoModeFormProps } from "./PotetoModeForm";

const validation = validatePotetoProjectSpecJson(POTETO_PROJECT_SPEC_EXAMPLE);
if (!validation.valid) throw new Error("Invalid test proposal");
const spec = validation.spec;
const draftResult = AsyncResult.success<PotetoDraftResult>({ status: "draft", spec });
const selection = { instanceId: ProviderInstanceId.make("pi"), model: "openai/gpt-5.4" };
let renderer: ReactTestRenderer | undefined;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  commands.draft.mockReset();
  commands.draft.mockResolvedValue(draftResult);
});
afterEach(async () => {
  if (renderer) await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function source(overrides: Partial<PotetoModeFormProps> = {}): PotetoModeFormProps {
  return {
    visible: true,
    environmentId: EnvironmentId.make("host-a"),
    modelSelection: selection,
    description: "  Fix truncate  ",
    hasAttachments: false,
    hasContext: false,
    getThreadId: vi.fn(async () => ThreadId.make("thread-a")),
    onClose: vi.fn(),
    onStart: vi.fn(async () => true),
    ...overrides,
  };
}
async function mount(props: PotetoModeFormProps) {
  await act(() => {
    renderer = create(
      <StrictMode>
        <PotetoModeForm {...props} />
      </StrictMode>,
    );
  });
}
function approval() {
  return renderer!.root.findByProps({ accessibilityLabel: "Approve and start" });
}
function messages() {
  return renderer!.root
    .findAllByType("span")
    .map((node) => node.children.join(" "))
    .join("\n");
}

it("drafts once under StrictMode even while creation is pending, and keeps the reviewed target and model", async () => {
  const created = Promise.withResolvers<ThreadId>();
  const proposal = Promise.withResolvers<AtomCommandResult<PotetoDraftResult, unknown>>();
  commands.draft.mockReturnValue(proposal.promise);
  const initial = source({ getThreadId: vi.fn(() => created.promise) });
  await mount(initial);
  expect(initial.getThreadId).toHaveBeenCalledTimes(1);
  expect(commands.draft).not.toHaveBeenCalled();
  expect(approval().props.disabled).toBe(true);
  const changed = source({
    environmentId: EnvironmentId.make("host-b"),
    modelSelection: { ...selection, model: "other-model" },
    description: "A different task",
  });
  await act(() =>
    renderer!.update(
      <StrictMode>
        <PotetoModeForm {...changed} />
      </StrictMode>,
    ),
  );
  await act(async () => {
    created.resolve(ThreadId.make("thread-a"));
    await created.promise;
  });
  expect(commands.draft).toHaveBeenCalledTimes(1);
  expect(commands.draft).toHaveBeenCalledWith({
    environmentId: initial.environmentId,
    input: { threadId: "thread-a", description: "Fix truncate", modelSelection: selection },
  });
  await act(async () => {
    proposal.resolve(draftResult);
    await proposal.promise;
  });
  expect(messages()).toContain(spec.task);
  expect(messages()).toContain(selection.model);
  expect(approval().props.disabled).toBe(false);
  await act(async () => {
    await approval().props.onPress();
  });
  expect(initial.onStart).toHaveBeenCalledWith(spec, initial.description, selection);
  expect(initial.onClose).toHaveBeenCalledTimes(1);
  expect(changed.getThreadId).not.toHaveBeenCalled();
  expect(changed.onStart).not.toHaveBeenCalled();
  expect(changed.onClose).not.toHaveBeenCalled();
});

it("ignores a late response after closing instead of displaying it in the next submission", async () => {
  const proposal = Promise.withResolvers<AtomCommandResult<PotetoDraftResult, unknown>>();
  commands.draft.mockReturnValueOnce(proposal.promise);
  const first = source();
  await mount(first);
  await act(() => renderer!.root.findByType("dialog").props.onRequestClose());
  expect(first.onClose).toHaveBeenCalledTimes(1);
  await act(() => renderer!.unmount());
  const next = source({ description: "New task" });
  await mount(next);
  await act(async () => {
    proposal.resolve(AsyncResult.success({ status: "unsupported", reason: "Old request" }));
    await proposal.promise;
  });
  expect(messages()).toContain(spec.task);
  expect(messages()).not.toContain("Old request");
  expect(first.onStart).not.toHaveBeenCalled();
  expect(next.onStart).not.toHaveBeenCalled();
});

it("guards rapid approval and close synchronously, then retains the proposal on a start error for retry", async () => {
  const firstStart = Promise.withResolvers<boolean>();
  const start = vi
    .fn<PotetoModeFormProps["onStart"]>()
    .mockReturnValueOnce(firstStart.promise)
    .mockResolvedValue(true);
  const initial = source({ onStart: start });
  await mount(initial);
  const press = approval().props.onPress;
  await act(() => {
    press();
    press();
    renderer!.root.findByType("dialog").props.onRequestClose();
    renderer!.root.findAllByType("button")[0]!.props.onPress();
  });
  expect(start).toHaveBeenCalledTimes(1);
  expect(initial.onClose).not.toHaveBeenCalled();
  await act(async () => {
    firstStart.reject(new Error("The Poteto request was interrupted. Try again."));
    await firstStart.promise.catch(() => undefined);
  });
  expect(messages()).toContain("interrupted");
  expect(messages()).toContain(spec.task);
  expect(approval().props.disabled).toBe(false);
  expect(initial.description).toBe("  Fix truncate  ");
  await act(async () => {
    press();
  });
  expect(start).toHaveBeenCalledTimes(2);
  expect(commands.draft).toHaveBeenCalledTimes(1);
  expect(initial.onClose).toHaveBeenCalledTimes(1);
});

it("refines in the original composer without starting the reviewed proposal", async () => {
  const initial = source();
  await mount(initial);
  await act(() => renderer!.root.findAllByType("button")[0]!.props.onPress());
  expect(initial.onClose).toHaveBeenCalledTimes(1);
  expect(initial.onStart).not.toHaveBeenCalled();
  expect(initial.description).toBe("  Fix truncate  ");
});

describe.each([
  ["attachments", { hasAttachments: true }],
  ["context records", { hasContext: true }],
  ["inline context references", { description: "Fix [file](rove-context://v1/file/context-1)" }],
  ["blank text", { description: "   " }],
  ["oversized text", { description: "a".repeat(4097) }],
])("invalid %s", (_name, overrides) => {
  it("shows feedback without creating a thread or drafting", async () => {
    const initial = source(overrides);
    await mount(initial);
    expect(initial.getThreadId).not.toHaveBeenCalled();
    expect(commands.draft).not.toHaveBeenCalled();
    expect(approval().props.disabled).toBe(true);
    expect(renderer!.root.findAllByProps({ accessibilityRole: "alert" })).toHaveLength(1);
    await act(() => renderer!.root.findAllByType("button")[0]!.props.onPress());
    expect(initial.onStart).not.toHaveBeenCalled();
  });
});

describe.each([
  [
    "unsupported",
    AsyncResult.success<PotetoDraftResult>({ status: "unsupported", reason: "Unsupported task" }),
    "Unsupported task",
  ],
  [
    "invalid scope",
    AsyncResult.success<PotetoDraftResult>({
      status: "draft",
      spec: { ...spec, editableFiles: ["../unsafe.ts"] },
    }),
    "repo-relative",
  ],
  ["interrupted", AsyncResult.failure<PotetoDraftResult, never>(Cause.interrupt(1)), "interrupted"],
  [
    "rejected",
    AsyncResult.failure<PotetoDraftResult, Error>(Cause.fail(new Error("Draft failed"))),
    "Draft failed",
  ],
] as const)("%s drafting", (_name, result, expectedError) => {
  it("keeps approval unavailable and leaves the composer prompt intact", async () => {
    commands.draft.mockResolvedValue(result);
    const initial = source();
    await mount(initial);
    expect(messages()).toContain(expectedError);
    expect(approval().props.disabled).toBe(true);
    expect(initial.description).toBe("  Fix truncate  ");
    expect(initial.onStart).not.toHaveBeenCalled();
  });
});
