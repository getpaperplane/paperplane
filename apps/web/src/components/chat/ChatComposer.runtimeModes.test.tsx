// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterContextProvider,
} from "@tanstack/react-router";
import { EnvironmentId, ThreadId, type ServerProvider } from "@getpaperplane/contracts";
import { AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerPromptEditorProps } from "../ComposerPromptEditor";
import type { ChatComposerProps } from "./ChatComposer";

vi.mock("../ComposerPromptEditor", () => ({
  ComposerPromptEditor(props: ComposerPromptEditorProps) {
    return <textarea aria-label="Composer prompt" value={props.value} readOnly />;
  },
}));

const noop = () => {};
const environmentId = EnvironmentId.make("composer-runtime-modes");
const threadRef = { environmentId, threadId: ThreadId.make("runtime-modes-thread") };

let ChatComposer: typeof import("./ChatComposer").ChatComposer;
let makeComposerProps: typeof import("./renderBenchFixtures").makeRenderBenchComposerProps;

function composerProps(
  overrides: Partial<ChatComposerProps> & {
    providerSupportedRuntimeModes?: ServerProvider["supportedRuntimeModes"];
  },
): ChatComposerProps {
  const base = makeComposerProps(threadRef, { providerReady: true });
  const [provider] = base.providerStatuses;
  const { providerSupportedRuntimeModes, ...rest } = overrides;
  return {
    ...base,
    ...rest,
    providerStatuses: [
      {
        ...provider!,
        supportedRuntimeModes: providerSupportedRuntimeModes,
      },
    ],
  };
}

describe("ChatComposer runtime mode options", () => {
  let root: Root;
  let container: HTMLElement;
  let registry: AtomRegistry.AtomRegistry;
  const router = createRouter({ routeTree: createRootRoute(), history: createMemoryHistory() });

  beforeAll(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(document, "fonts", { configurable: true, value: new EventTarget() });
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    vi.stubGlobal(
      "IntersectionObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    window.matchMedia = (media) => ({
      matches: false,
      media,
      onchange: null,
      addListener: noop,
      removeListener: noop,
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => false,
    });
    ({ ChatComposer } = await import("./ChatComposer"));
    ({ makeRenderBenchComposerProps: makeComposerProps } = await import("./renderBenchFixtures"));
    registry = AtomRegistry.make();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  }, 120_000);

  afterAll(async () => {
    await act(async () => root.unmount());
    registry.dispose();
    container.remove();
    Reflect.deleteProperty(document, "fonts");
    vi.unstubAllGlobals();
  });

  async function renderComposer(props: ChatComposerProps) {
    await act(async () =>
      root.render(
        <RegistryContext.Provider value={registry}>
          <RouterContextProvider router={router}>
            <ChatComposer {...props} />
          </RouterContextProvider>
        </RegistryContext.Provider>,
      ),
    );
  }

  it("falls back to the provider's first supported mode and follows supported-mode changes", async () => {
    // "auto" is not offered by this provider, so the footer shows the first
    // supported option instead of the saved mode.
    await renderComposer(
      composerProps({
        runtimeMode: "auto",
        providerSupportedRuntimeModes: ["approval-required", "full-access"],
      }),
    );
    expect(container.textContent).toContain("Supervised");
    expect(container.textContent).not.toContain("Auto-accept");

    await renderComposer(
      composerProps({ runtimeMode: "auto", providerSupportedRuntimeModes: ["full-access"] }),
    );
    expect(container.textContent).toContain("Full access");
    expect(container.textContent).not.toContain("Supervised");

    // A provider that reports no list keeps the full set, so the saved mode shows again.
    await renderComposer(
      composerProps({ runtimeMode: "auto", providerSupportedRuntimeModes: undefined }),
    );
    expect(container.textContent).toContain("Auto");
    expect(container.textContent).not.toContain("Full access");
  }, 120_000);
});
