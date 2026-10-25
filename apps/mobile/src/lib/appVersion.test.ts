import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { readAppVersion, readNativeBuildNumber } from "./appVersion";

const mocks = vi.hoisted(() => ({
  application: {
    nativeApplicationVersion: "0.1.1" as string | null,
    nativeBuildVersion: "215095942" as string | null,
  },
  constants: {
    expoConfig: null as {
      version?: string;
      extra?: { releaseVersion?: unknown };
      ios?: { buildNumber: string };
      android?: { versionCode: number };
    } | null,
  },
}));

vi.mock("expo-application", () => mocks.application);
vi.mock("expo-constants", () => ({ default: mocks.constants }));

beforeEach(() => {
  mocks.application.nativeApplicationVersion = "0.1.1";
  mocks.application.nativeBuildVersion = "215095942";
  mocks.constants.expoConfig = { version: "0.1.1" };
});

describe("mobile app identity", () => {
  it("distinguishes nightlies with the same numeric native version", () => {
    mocks.constants.expoConfig = {
      version: "0.1.1",
      extra: { releaseVersion: " 0.1.1-nightly.20261025.748 " },
    };
    expect(readAppVersion()).toBe("0.1.1-nightly.20261025.748");
    expect(readNativeBuildNumber()).toBe("215095942");
  });

  it.each([undefined, null, "", "   ", 748, { version: "0.1.1" }])(
    "uses the native version when release metadata is absent or invalid (%j)",
    (releaseVersion) => {
      mocks.constants.expoConfig = {
        version: "2.0.0",
        extra: { releaseVersion },
      };
      expect(readAppVersion()).toBe("0.1.1");
    },
  );

  it("falls back to config when no native version is available", () => {
    mocks.application.nativeApplicationVersion = null;
    mocks.constants.expoConfig = { version: "2.0.0" };
    expect(readAppVersion()).toBe("2.0.0");
  });

  it("handles missing config and native identity", () => {
    mocks.application.nativeApplicationVersion = null;
    mocks.application.nativeBuildVersion = null;
    mocks.constants.expoConfig = null;
    expect(readAppVersion()).toBe("0.0.0");
    expect(readNativeBuildNumber()).toBeUndefined();
  });

  it("keeps the installed build number even when Metro or OTA config differs", () => {
    mocks.constants.expoConfig = {
      ios: { buildNumber: "999" },
      android: { versionCode: 999 },
    };
    expect(readNativeBuildNumber()).toBe("215095942");
  });

  it("does not invent an installed build number from config", () => {
    mocks.application.nativeBuildVersion = null;
    mocks.constants.expoConfig = {
      ios: { buildNumber: "999" },
      android: { versionCode: 999 },
    };
    expect(readNativeBuildNumber()).toBeUndefined();
  });
});
