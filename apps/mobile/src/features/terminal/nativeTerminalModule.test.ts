import { testDouble } from "../../testDouble";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const expoMocks = vi.hoisted(() => ({
  requireNativeView: vi.fn(),
  requireOptionalNativeModule: vi.fn(),
}));
const nativeView = () => null;
const originalExpo = globalThis.expo;

function setExpoViewConfigAvailable() {
  globalThis.expo = testDouble<typeof globalThis.expo>({
    getViewConfig: vi.fn().mockReturnValue({ validAttributes: {}, directEventTypes: {} }),
  });
}

vi.mock("expo", () => ({
  requireNativeView: expoMocks.requireNativeView,
  requireOptionalNativeModule: expoMocks.requireOptionalNativeModule,
}));

describe("resolveNativeTerminalSurfaceView", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.resetModules();
    globalThis.expo = testDouble<typeof globalThis.expo>(undefined);
  });

  afterEach(() => {
    globalThis.expo = originalExpo;
  });

  it("returns null when the native terminal view config is unavailable", async () => {
    const { resolveNativeTerminalSurfaceView } = await import("./nativeTerminalModule");
    expect(resolveNativeTerminalSurfaceView()).toBeNull();
    expect(expoMocks.requireNativeView).not.toHaveBeenCalled();
  });

  it("returns the native terminal view when the view config is installed", async () => {
    setExpoViewConfigAvailable();
    expoMocks.requireNativeView.mockReturnValue(nativeView);
    const { resolveNativeTerminalSurfaceView } = await import("./nativeTerminalModule");
    expect(resolveNativeTerminalSurfaceView()).toBe(nativeView);
    expect(expoMocks.requireNativeView).toHaveBeenCalledWith("PaperplaneTerminalSurface");
  });

  it.each([undefined, null, {}, { outputRevision: 0 }])(
    "keeps legacy output for installed modules without streaming support (%s)",
    async (module) => {
      setExpoViewConfigAvailable();
      expoMocks.requireNativeView.mockReturnValue(nativeView);
      expoMocks.requireOptionalNativeModule.mockReturnValue(module);
      const { supportsNativeTerminalOutput } = await import("./nativeTerminalModule");
      expect(supportsNativeTerminalOutput()).toBe(false);
    },
  );

  it("enables streaming only when both the API revision and view are installed", async () => {
    expoMocks.requireOptionalNativeModule.mockReturnValue({ outputRevision: 1 });
    const { supportsNativeTerminalOutput } = await import("./nativeTerminalModule");
    expect(supportsNativeTerminalOutput()).toBe(false);
    setExpoViewConfigAvailable();
    expoMocks.requireNativeView.mockReturnValue(nativeView);
    expect(supportsNativeTerminalOutput()).toBe(true);
  });

  it("falls back if reading native capabilities throws", async () => {
    expoMocks.requireOptionalNativeModule.mockImplementation(() => {
      throw new Error("unavailable");
    });
    const { supportsNativeTerminalOutput } = await import("./nativeTerminalModule");
    expect(supportsNativeTerminalOutput()).toBe(false);
  });

  it("returns null when the view manager cannot be required", async () => {
    setExpoViewConfigAvailable();
    const cause = new Error("boom");
    expoMocks.requireNativeView.mockImplementation(() => {
      throw cause;
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { resolveNativeTerminalSurfaceView } = await import("./nativeTerminalModule");

    expect(resolveNativeTerminalSurfaceView()).toBeNull();
    expect(resolveNativeTerminalSurfaceView()).toBeNull();
    expect(expoMocks.requireNativeView).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      expect.objectContaining({
        _tag: "NativeViewResolutionError",
        nativeModuleName: "PaperplaneTerminalSurface",
        cause,
      }),
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
