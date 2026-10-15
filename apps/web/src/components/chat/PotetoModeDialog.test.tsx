import {
  act,
  cloneElement,
  createElement,
  StrictMode,
  type ReactElement,
  type ReactNode,
} from "react";
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
import { PotetoModeDialog } from "./PotetoModeDialog";

const firstModel = { instanceId: "pi", model: "fixture/first" } as ModelSelection;
const otherModel = { instanceId: "pi", model: "fixture/other" } as ModelSelection;
const description = "text.ts adds too many dots";
const spec = {
  task: "Respect the boundary",
  editableFiles: ["text.ts"],
  contextFiles: [],
  check: { module: "text.ts", export: "truncate", cases: [{ args: ["hello", 2], expected: ".." }] },
};
let renderer: ReactTestRenderer | undefined;
let model: ModelSelection;
const prepareDraft = vi.fn();
const prepare = vi.fn();
const close = vi.fn();
const started = vi.fn();

beforeEach(() => {
  model = firstModel;
  vi.clearAllMocks();
  commands.draft.mockResolvedValue(AsyncResult.success({ status: "draft", spec }));
  commands.start.mockResolvedValue(AsyncResult.success(undefined));
  prepareDraft.mockResolvedValue(AsyncResult.success(undefined));
  prepare.mockResolvedValue(AsyncResult.success(undefined));
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
});
async function open(text = description) {
  await act(async () => {
    renderer = create(
      <StrictMode>
        <PotetoModeDialog
          environmentId={"env" as EnvironmentId}
          threadId={"thread" as ThreadId}
          open
          enabled
          description={text}
          getModelSelection={() => model}
          onBeforeDraft={prepareDraft}
          onBeforeStart={prepare}
          onOpenChange={close}
          onStarted={started}
        />
      </StrictMode>,
    );
  });
}
const submit = () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
const visibleText = () => JSON.stringify(renderer!.toJSON());

it("uses the composer description automatically and waits for approval with the frozen model", async () => {
  await open(`  ${description}  `);
  expect(commands.draft).toHaveBeenCalledTimes(1);
  expect(commands.draft).toHaveBeenCalledWith({
    environmentId: "env",
    input: { threadId: "thread", description, modelSelection: firstModel },
  });
  expect(commands.start).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(visibleText()).toContain("What counts as fixed");
  model = otherModel;
  let release: (() => void) | undefined;
  prepare.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(AsyncResult.success(undefined));
      }),
  );
  await act(async () => {
    submit();
    submit();
    renderer!.root
      .findAllByType("button")
      .find((button) => button.props.type === "button")!
      .props.onClick();
  });
  expect(close).not.toHaveBeenCalled();
  expect(prepare).toHaveBeenCalledTimes(1);
  expect(prepare).toHaveBeenCalledWith(firstModel);
  expect(commands.start).not.toHaveBeenCalled();
  await act(async () => {
    release?.();
  });
  expect(commands.start).toHaveBeenCalledWith({
    environmentId: "env",
    input: { threadId: "thread", spec },
  });
  expect(started).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledWith(false);
});

it("prepares the empty thread before drafting without starting a normal prompt", async () => {
  let release: (() => void) | undefined;
  prepareDraft.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(AsyncResult.success(undefined));
      }),
  );
  await open();
  await act(async () => {
    submit();
  });
  expect(prepareDraft).toHaveBeenCalledTimes(1);
  expect(prepareDraft).toHaveBeenCalledWith(firstModel);
  expect(commands.draft).not.toHaveBeenCalled();
  expect(commands.start).not.toHaveBeenCalled();
  await act(async () => {
    release?.();
  });
  expect(commands.draft).toHaveBeenCalledTimes(1);
  expect(commands.start).not.toHaveBeenCalled();
});

it("keeps the composer description retryable when thread preparation fails", async () => {
  prepareDraft.mockResolvedValue(AsyncResult.failure(Cause.fail(new Error("Choose Local first."))));
  await open();
  expect(visibleText()).toContain("Choose Local first.");
  expect(visibleText()).toContain(description);
  expect(commands.draft).not.toHaveBeenCalled();
  expect(started).not.toHaveBeenCalled();
  prepareDraft.mockResolvedValue(AsyncResult.success(undefined));
  await act(async () => {
    submit();
  });
  expect(commands.draft).toHaveBeenCalledTimes(1);
});

it("retains unsupported descriptions and retries without exposing approval", async () => {
  commands.draft.mockResolvedValue(
    AsyncResult.success({ status: "unsupported", reason: "Needs a browser." }),
  );
  await open();
  expect(visibleText()).toContain("Needs a browser.");
  expect(visibleText()).toContain(description);
  expect(visibleText()).not.toContain("Approve & start");
  expect(commands.start).not.toHaveBeenCalled();
  commands.draft.mockResolvedValue(AsyncResult.success({ status: "draft", spec }));
  await act(async () => {
    submit();
  });
  expect(visibleText()).toContain("What counts as fixed");
  expect(commands.start).not.toHaveBeenCalled();
});

it("single-flights drafting and rejects invalid scope before approval", async () => {
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
  await open();
  await act(async () => {
    submit();
    submit();
  });
  expect(commands.draft).toHaveBeenCalledTimes(1);
  await act(async () => {
    release?.();
  });
  expect(visibleText()).toContain("could not be validated");
  expect(commands.start).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
});

it("preserves the reviewed proposal and text when starting fails", async () => {
  commands.start.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new Error("Docker unavailable."))),
  );
  await open();
  await act(async () => {
    submit();
  });
  expect(visibleText()).toContain("Docker unavailable.");
  expect(visibleText()).toContain("What counts as fixed");
  expect(started).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
  commands.start.mockResolvedValue(AsyncResult.success(undefined));
  await act(async () => {
    submit();
  });
  expect(started).toHaveBeenCalledTimes(1);
  expect(commands.draft).toHaveBeenCalledTimes(1);
});

it("returns to the composer without consuming text or starting checks", async () => {
  await open();
  await act(async () => {
    renderer!.root
      .findAllByType("button")
      .find((button) => button.props.type === "button")!
      .props.onClick();
  });
  expect(close).toHaveBeenCalledWith(false);
  expect(started).not.toHaveBeenCalled();
  expect(commands.start).not.toHaveBeenCalled();
});

it("does not begin drafting if the dialog unmounts during thread preparation", async () => {
  let release: (() => void) | undefined;
  prepareDraft.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(AsyncResult.success(undefined));
      }),
  );
  await open();
  await act(async () => {
    renderer!.unmount();
  });
  await act(async () => {
    release?.();
  });
  expect(commands.draft).not.toHaveBeenCalled();
  expect(started).not.toHaveBeenCalled();
});

it("does not clear another composer's text after navigation during approval", async () => {
  let release: (() => void) | undefined;
  commands.start.mockImplementation(
    () =>
      new Promise((resolve) => {
        release = () => resolve(AsyncResult.success(undefined));
      }),
  );
  await open();
  await act(async () => {
    submit();
  });
  await act(async () => {
    renderer!.unmount();
  });
  await act(async () => {
    release?.();
  });
  expect(started).not.toHaveBeenCalled();
  expect(close).not.toHaveBeenCalled();
});

it.each(["   ", "x".repeat(4097)])(
  "rejects invalid composer descriptions without model usage",
  async (text) => {
    await open(text);
    expect(visibleText()).toContain("up to 4096 characters");
    expect(prepareDraft).not.toHaveBeenCalled();
    expect(commands.draft).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  },
);
