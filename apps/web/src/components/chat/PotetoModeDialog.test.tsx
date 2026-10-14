import { act, cloneElement, createElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import type { EnvironmentId, ModelSelection, ThreadId } from "@rove-code/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const commands = vi.hoisted(() => ({ draft: vi.fn(), start: vi.fn() }));
vi.mock("~/state/server", () => ({ serverEnvironment: { potetoDraft: "draft" } }));
vi.mock("~/state/threads", () => ({ threadEnvironment: { startPoteto: "start" } }));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: "draft" | "start") => commands[command],
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => children,
  DialogPopup: ({ children, render }: { children: ReactNode; render: ReactElement }) =>
    cloneElement(render, {}, children),
  DialogHeader: ({ children }: { children: ReactNode }) => createElement("header", {}, children),
  DialogTitle: ({ children }: { children: ReactNode }) => createElement("h2", {}, children),
  DialogDescription: ({ children }: { children: ReactNode }) => createElement("p", {}, children),
  DialogPanel: ({ children }: { children: ReactNode }) => createElement("main", {}, children),
  DialogFooter: ({ children }: { children: ReactNode }) => createElement("footer", {}, children),
}));
vi.mock("../ui/button", () => ({ Button: "button" }));
vi.mock("../ui/textarea", () => ({ Textarea: "textarea" }));
import { PotetoModeDialog } from "./PotetoModeDialog";

const firstModel = { instanceId: "pi", model: "fixture/first" } as ModelSelection;
const otherModel = { instanceId: "pi", model: "fixture/other" } as ModelSelection;
const spec = {
  task: "Respect the boundary",
  editableFiles: ["text.ts"],
  contextFiles: [],
  check: { module: "text.ts", export: "truncate", cases: [{ args: ["hello", 2], expected: ".." }] },
};
let renderer: ReactTestRenderer;
let model: ModelSelection;
const prepareDraft = vi.fn();
const prepare = vi.fn();
const close = vi.fn();

beforeEach(async () => {
  model = firstModel;
  vi.clearAllMocks();
  commands.draft.mockResolvedValue(AsyncResult.success({ status: "draft", spec }));
  commands.start.mockResolvedValue(AsyncResult.success(undefined));
  prepareDraft.mockResolvedValue(AsyncResult.success(undefined));
  prepare.mockResolvedValue(AsyncResult.success(undefined));
  await act(async () => {
    renderer = create(
      <PotetoModeDialog
        environmentId={"env" as EnvironmentId}
        threadId={"thread" as ThreadId}
        open
        enabled
        getModelSelection={() => model}
        onBeforeDraft={prepareDraft}
        onBeforeStart={prepare}
        onOpenChange={close}
      />,
    );
  });
});
afterEach(async () => {
  await act(async () => renderer.unmount());
});
const submit = () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} });
async function describe() {
  await act(async () => {
    renderer.root
      .findByType("textarea")
      .props.onChange({ currentTarget: { value: "text.ts adds too many dots" } });
  });
}

it("makes drafting non-executing and waits for explicit approval with the frozen model", async () => {
  await describe();
  await act(async () => {
    await submit();
  });
  expect(commands.start).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(JSON.stringify(renderer.toJSON())).toContain("What counts as fixed");
  model = otherModel;
  let release: (() => void) | undefined;
  prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(AsyncResult.success(undefined));
      }),
  );
  let finishing: Promise<void> | undefined;
  await act(async () => {
    finishing = submit();
  });
  expect(prepare).toHaveBeenCalledWith(firstModel);
  expect(commands.start).not.toHaveBeenCalled();
  await act(async () => {
    release?.();
    await finishing;
  });
  expect(commands.start).toHaveBeenCalledWith({
    environmentId: "env",
    input: { threadId: "thread", spec },
  });
  expect(close).toHaveBeenCalledWith(false);
});

it("creates the empty thread before drafting, without starting a normal prompt", async () => {
  let release: (() => void) | undefined;
  prepareDraft.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(AsyncResult.success(undefined));
      }),
  );
  await describe();
  let finishing: Promise<void> | undefined;
  await act(async () => {
    finishing = submit();
  });
  expect(prepareDraft).toHaveBeenCalledWith(firstModel);
  expect(commands.draft).not.toHaveBeenCalled();
  expect(commands.start).not.toHaveBeenCalled();
  await act(async () => {
    release?.();
    await finishing;
  });
  expect(commands.draft).toHaveBeenCalledWith({
    environmentId: "env",
    input: {
      threadId: "thread",
      description: "text.ts adds too many dots",
      modelSelection: firstModel,
    },
  });
  expect(commands.start).not.toHaveBeenCalled();
});

it("keeps the description retryable when empty-thread creation fails", async () => {
  prepareDraft.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Choose Local first."))));
  await describe();
  await act(async () => {
    await submit();
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("Choose Local first.");
  expect(renderer.root.findByType("textarea").props.value).toBe("text.ts adds too many dots");
  expect(commands.draft).not.toHaveBeenCalled();
  expect(commands.start).not.toHaveBeenCalled();
  prepareDraft.mockResolvedValue(AsyncResult.success(undefined));
  await act(async () => {
    await submit();
  });
  expect(commands.draft).toHaveBeenCalledTimes(1);
});

it("retains the description on unsupported drafts and never exposes approval", async () => {
  commands.draft.mockResolvedValue(
    AsyncResult.success({ status: "unsupported", reason: "Needs a browser." }),
  );
  await describe();
  await act(async () => {
    await submit();
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("Needs a browser.");
  expect(renderer.root.findByType("textarea").props.value).toBe("text.ts adds too many dots");
  expect(commands.start).not.toHaveBeenCalled();
  commands.draft.mockResolvedValue(AsyncResult.success({ status: "draft", spec }));
  await act(async () => {
    await submit();
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("What counts as fixed");
  expect(commands.start).not.toHaveBeenCalled();
});

it("single-flights a double submit and rejects invalid scope before approval", async () => {
  let release: (() => void) | undefined;
  commands.draft.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () =>
          resolve(
            AsyncResult.success({
              status: "draft",
              spec: { ...spec, editableFiles: ["../text.ts"] },
            }),
          );
      }),
  );
  await describe();
  let finishing: Promise<void> | undefined;
  await act(async () => {
    finishing = submit();
    await submit();
  });
  expect(commands.draft).toHaveBeenCalledTimes(1);
  await act(async () => {
    release?.();
    await finishing;
  });
  expect(JSON.stringify(renderer.toJSON())).toContain("could not be validated");
  expect(commands.start).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});
