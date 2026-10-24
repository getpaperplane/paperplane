import type { EnvironmentId, RoveProjectFileScript, ThreadId } from "@getpaperplane/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { AsyncResult } from "effect/reactivity";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { PopoverCreateHandle } from "../ui/popover";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  useRoveProjectFileScripts: vi.fn(),
  projectScriptsControl: vi.fn(),
}));

vi.mock("../../hooks/useRoveProjectFileScripts", () => ({
  useRoveProjectFileScripts: (...args: ReadonlyArray<unknown>) =>
    testState.useRoveProjectFileScripts(...args),
}));
vi.mock("../BranchToolbar", () => ({
  BranchToolbar: () => null,
}));
vi.mock("../ProjectScriptsControl", () => ({
  default: (props: unknown) => {
    testState.projectScriptsControl(props);
    return null;
  },
}));
vi.mock("./ThreadAutomationsPanel", () => ({
  ThreadAutomationsPanel: () => null,
}));
vi.mock("./ThreadRelationshipsControl", () => ({
  ThreadRelationshipsPanel: () => null,
}));
vi.mock("./ThreadDetailsCard", () => ({
  ThreadDetailsCard: ({ children }: { children: (density: "full") => React.ReactNode }) =>
    children("full"),
}));

import { ThreadDetailsPanel, type ThreadDetailsPanelProps } from "./ThreadDetailsPanel";

describe("ThreadDetailsPanel", () => {
  beforeEach(() => {
    testState.useRoveProjectFileScripts.mockReset();
    testState.projectScriptsControl.mockReset();
  });

  it("passes checked-in rove.json scripts to the project scripts control", () => {
    const environmentId = "environment:thread-details" as EnvironmentId;
    const gitCwd = "/tmp/thread-details-project";
    const fileScripts = [
      {
        name: "Check project",
        command: "vp check",
        icon: "test",
      },
    ] satisfies ReadonlyArray<RoveProjectFileScript>;
    testState.useRoveProjectFileScripts.mockReturnValue(fileScripts);

    const props: ThreadDetailsPanelProps = {
      anchor: { current: null },
      handle: PopoverCreateHandle(),
      onPresentationChange: vi.fn(),
      environmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd,
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      envMode: "local",
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi
        .fn<ThreadDetailsPanelProps["onAddProjectScript"]>()
        .mockResolvedValue(AsyncResult.success(undefined)),
      onUpdateProjectScript: vi
        .fn<ThreadDetailsPanelProps["onUpdateProjectScript"]>()
        .mockResolvedValue(AsyncResult.success(undefined)),
      onDeleteProjectScript: vi
        .fn<ThreadDetailsPanelProps["onDeleteProjectScript"]>()
        .mockResolvedValue(AsyncResult.success(undefined)),
    };

    renderToStaticMarkup(<ThreadDetailsPanel {...props} />);

    expect(testState.useRoveProjectFileScripts).toHaveBeenCalledWith(environmentId, gitCwd);
    expect(testState.projectScriptsControl).toHaveBeenCalledWith(
      expect.objectContaining({
        displayMode: "panel",
        scripts: [],
        fileScripts,
      }),
    );
  });

  it("skips re-rendering for unchanged props and updates when thread metadata changes", () => {
    testState.useRoveProjectFileScripts.mockReturnValue([]);
    const props: ThreadDetailsPanelProps = {
      anchor: { current: null },
      handle: PopoverCreateHandle(),
      onPresentationChange: vi.fn(),
      environmentId: "environment:thread-details" as EnvironmentId,
      threadId: "thread:thread-details" as ThreadId,
      activeProjectName: undefined,
      activeProjectScripts: [],
      preferredScriptId: null,
      keybindings: [],
      availableEditors: [],
      showOpenInPicker: false,
      gitCwd: "/tmp/thread-details-project",
      isGitRepo: false,
      envLocked: false,
      availableEnvironments: [],
      onEnvironmentChange: vi.fn(),
      onEnvModeChange: vi.fn(),
      envMode: "local",
      startFromOrigin: false,
      onStartFromOriginChange: vi.fn(),
      onComposerFocusRequest: vi.fn(),
      onRunProjectScript: vi.fn(),
      onAddProjectScript: vi
        .fn<ThreadDetailsPanelProps["onAddProjectScript"]>()
        .mockResolvedValue(AsyncResult.success(undefined)),
      onUpdateProjectScript: vi
        .fn<ThreadDetailsPanelProps["onUpdateProjectScript"]>()
        .mockResolvedValue(AsyncResult.success(undefined)),
      onDeleteProjectScript: vi
        .fn<ThreadDetailsPanelProps["onDeleteProjectScript"]>()
        .mockResolvedValue(AsyncResult.success(undefined)),
    };

    let renderer: ReactTestRenderer | undefined;
    act(() => {
      renderer = create(<ThreadDetailsPanel {...props} />);
    });
    const rendersAfterMount = testState.projectScriptsControl.mock.calls.length;

    // Isolated memo contract only; the connected transcript test covers stream isolation.
    act(() => {
      renderer?.update(<ThreadDetailsPanel {...{ ...props }} />);
    });
    expect(testState.projectScriptsControl.mock.calls.length).toBe(rendersAfterMount);

    act(() => {
      renderer?.update(<ThreadDetailsPanel {...props} preferredScriptId="script:check" />);
    });
    expect(testState.projectScriptsControl.mock.calls.length).toBeGreaterThan(rendersAfterMount);
    expect(testState.projectScriptsControl).toHaveBeenLastCalledWith(
      expect.objectContaining({ preferredScriptId: "script:check" }),
    );
    act(() => renderer?.unmount());
  });
});
