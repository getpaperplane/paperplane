import * as NodeFS from "node:fs";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const configEnv = vi.hoisted(() => ({ current: {} }));
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => configEnv.current,
}));

const originalEnv = { ...process.env };
const configuredKeys = [
  "APP_VARIANT",
  "PAPERPLANE_CLOUD_READY",
  "PAPERPLANE_RELAY_URL",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
  "EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID",
  "PAPERPLANE_EXPO_PROJECT_ID",
  "PAPERPLANE_EXPO_OWNER",
  "PAPERPLANE_MOBILE_UPDATES_ENABLED",
  "PAPERPLANE_APPLE_TEAM_ID",
  "PAPERPLANE_IOS_UNSIGNED",
  "PAPERPLANE_IOS_PERSONAL_TEAM",
  "PAPERPLANE_IOS_PERSONAL_TEAM_BUNDLE_ID",
  "PAPERPLANE_MOBILE_VERSION",
  "PAPERPLANE_MOBILE_BUILD_NUMBER",
  "PAPERPLANE_CLERK_RELYING_PARTY_DOMAIN",
];

async function configFor(env: Record<string, string>) {
  configEnv.current = env;
  vi.resetModules();
  return (await import("./app.config")).default;
}

afterEach(() => {
  for (const key of configuredKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  vi.resetModules();
});

describe("source-built mobile identity", () => {
  it("does not enroll an unconfigured app in upstream Expo, Clerk, or Apple infrastructure", async () => {
    const config = await configFor({});
    expect(config.updates?.enabled).toBe(false);
    expect(config.updates?.url).toBeUndefined();
    expect(config.extra?.eas).toBeUndefined();
    expect(config.owner).toBeUndefined();
    expect(config.ios?.appleTeamId).toBeUndefined();
    expect(config.ios?.associatedDomains).toEqual([]);
  });

  it("uses explicitly configured, project-owned native identities", async () => {
    const config = await configFor({
      PAPERPLANE_CLOUD_READY: "1",
      PAPERPLANE_EXPO_PROJECT_ID: "00000000-0000-4000-8000-000000000000",
      PAPERPLANE_EXPO_OWNER: "paperplane-test",
      PAPERPLANE_MOBILE_UPDATES_ENABLED: "1",
      PAPERPLANE_APPLE_TEAM_ID: "ABCDE12345",
      PAPERPLANE_CLERK_RELYING_PARTY_DOMAIN: "paperplane.example.test",
    });
    expect(config.updates?.enabled).toBe(true);
    expect(config.updates?.url).toBe("https://u.expo.dev/00000000-0000-4000-8000-000000000000");
    expect(config.extra?.eas).toEqual({ projectId: "00000000-0000-4000-8000-000000000000" });
    expect(config.owner).toBe("paperplane-test");
    expect(config.ios?.appleTeamId).toBe("ABCDE12345");
    expect(config.ios?.associatedDomains).toEqual([
      "applinks:paperplane.example.test",
      "webcredentials:paperplane.example.test",
    ]);
  });

  it.each([undefined, "0", "1"])(
    "gates configured Paperplane Connect infrastructure (%s)",
    async (gate) => {
      const config = await configFor({
        ...(gate ? { PAPERPLANE_CLOUD_READY: gate } : undefined),
        PAPERPLANE_RELAY_URL: "https://relay.example.test",
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
        EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "paperplane-relay",
        EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID: "google-web",
      });
      expect(config.extra?.cloudReady).toBe(gate === "1");
      expect(config.extra?.relay.url).toBe(gate === "1" ? "https://relay.example.test" : null);
      expect(config.extra?.clerk.publishableKey).toBe(gate === "1" ? "pk_test_example" : null);
      expect(config.extra?.EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID).toBe(
        gate === "1" ? "google-web" : undefined,
      );
    },
  );

  it.each([
    ["development", "Paperplane Dev", "io.github.getpaperplane.paperplane.dev"],
    ["preview", "Paperplane Preview", "io.github.getpaperplane.paperplane.preview"],
    ["production", "Paperplane", "io.github.getpaperplane.paperplane"],
  ])("retains the %s Paperplane app identity", async (variant, name, id) => {
    const config = await configFor({ APP_VARIANT: variant });
    expect(config.name).toBe(name);
    expect(config.ios?.bundleIdentifier).toBe(id);
    expect(config.android?.package).toBe(id);
    expect(config.ios?.entitlements?.["keychain-access-groups"]).toEqual([
      `$(AppIdentifierPrefix)${id}`,
    ]);
    expect(config.plugins).toContainEqual([
      "expo-widgets",
      expect.objectContaining({
        bundleIdentifier: `${id}.widgets`,
        groupIdentifier: `group.${id}`,
      }),
    ]);
    expect(config.plugins).toContainEqual([
      "expo-sharing",
      expect.objectContaining({
        ios: expect.objectContaining({
          extensionBundleIdentifier: `${id}.sharing`,
          appGroupId: `group.${id}`,
        }),
      }),
    ]);
  });

  it("configures an unsigned production IPA without paid-team capabilities", async () => {
    const config = await configFor({ APP_VARIANT: "production", PAPERPLANE_IOS_UNSIGNED: "1" });
    expect(config.ios?.bundleIdentifier).toBe("io.github.getpaperplane.paperplane");
    expect(config.android?.package).toBe("io.github.getpaperplane.paperplane");
    expect(config.ios?.entitlements).toEqual({});
    expect(config.extra?.iosPersonalTeamBuild).toBe(true);
    expect(config.extra?.cloudReady).toBe(false);
    expect(config.updates?.enabled).toBe(false);
    expect(config.plugins).toContain("./plugins/withoutIosPersonalTeamCapabilities.cjs");
    expect(config.plugins).not.toContain("./plugins/withShareExtensionDisplayName.cjs");
    expect(
      config.plugins?.some((plugin) => Array.isArray(plugin) && plugin[0] === "expo-widgets"),
    ).toBe(false);
    expect(config.plugins).toContainEqual([
      "@clerk/expo",
      { theme: "./clerk-theme.json", appleSignIn: false },
    ]);
    const sharing = config.plugins?.find(
      (plugin) => Array.isArray(plugin) && plugin[0] === "expo-sharing",
    );
    expect(sharing).toEqual([
      "expo-sharing",
      expect.objectContaining({ ios: expect.objectContaining({ enabled: false }) }),
    ]);
  });

  it("allows an explicit unsigned bundle ID but still validates it", async () => {
    const config = await configFor({
      PAPERPLANE_IOS_UNSIGNED: "1",
      PAPERPLANE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.sideload",
    });
    expect(config.ios?.bundleIdentifier).toBe("com.example.sideload");
    await expect(
      configFor({
        PAPERPLANE_IOS_UNSIGNED: "1",
        PAPERPLANE_IOS_PERSONAL_TEAM_BUNDLE_ID: "not an identifier",
      }),
    ).rejects.toThrow("PAPERPLANE_IOS_PERSONAL_TEAM_BUNDLE_ID");
  });

  it("keeps local Personal Team builds explicit and uses their default keychain group", async () => {
    await expect(configFor({ PAPERPLANE_IOS_PERSONAL_TEAM: "1" })).rejects.toThrow(
      "PAPERPLANE_IOS_PERSONAL_TEAM_BUNDLE_ID",
    );
    const config = await configFor({
      PAPERPLANE_IOS_PERSONAL_TEAM: "1",
      PAPERPLANE_IOS_PERSONAL_TEAM_BUNDLE_ID: "com.example.paperplane",
    });
    expect(config.ios?.bundleIdentifier).toBe("com.example.paperplane");
    expect(config.ios?.entitlements).toEqual({});
    const regular = await configFor({});
    expect(regular.ios?.entitlements?.["keychain-access-groups"]).toEqual([
      "$(AppIdentifierPrefix)io.github.getpaperplane.paperplane",
    ]);
  });

  it("uses the release version and a shared monotonic native build number", async () => {
    const config = await configFor({
      PAPERPLANE_MOBILE_VERSION: "2.1.0",
      PAPERPLANE_MOBILE_BUILD_NUMBER: "205000001",
    });
    expect(config.version).toBe("2.1.0");
    expect(config.ios?.buildNumber).toBe("205000001");
    expect(config.android?.versionCode).toBe(205000001);
    const unconfigured = await configFor({});
    expect(unconfigured.ios?.buildNumber).toBeUndefined();
    expect(unconfigured.android?.versionCode).toBeUndefined();
  });

  it.each(["0", "-1", "1.5", "abc", "2100000001", ""])(
    "rejects invalid build number %s",
    async (value) => {
      await expect(configFor({ PAPERPLANE_MOBILE_BUILD_NUMBER: value })).rejects.toThrow(
        "PAPERPLANE_MOBILE_BUILD_NUMBER",
      );
    },
  );

  it("refuses OTA updates without a project ID", async () => {
    await expect(configFor({ PAPERPLANE_MOBILE_UPDATES_ENABLED: "1" })).rejects.toThrow(
      "PAPERPLANE_EXPO_PROJECT_ID is required",
    );
  });

  it("refuses upstream relying-party domains even if explicitly configured", async () => {
    await expect(
      configFor({
        PAPERPLANE_CLOUD_READY: "1",
        PAPERPLANE_CLERK_RELYING_PARTY_DOMAIN: "clerk.t3.codes",
      }),
    ).rejects.toThrow("must belong to this project");
  });
});

describe("speech recognition platform config", () => {
  const pkg = JSON.parse(NodeFS.readFileSync(new URL("./package.json", import.meta.url), "utf8"));

  it("links expo-speech-recognition on Android only", () => {
    expect(pkg.expo.autolinking.ios.exclude).toEqual(["expo-speech-recognition"]);
    expect(pkg.expo.autolinking.android).toBeUndefined();
  });

  it("applies only the Android half of the speech plugin, leaving iOS plist untouched", async () => {
    const config = await configFor({});
    const pluginNames = (config.plugins ?? []).map((plugin) =>
      Array.isArray(plugin) ? plugin[0] : plugin,
    );
    expect(pluginNames).toContain("./plugins/withAndroidSpeechRecognition.cjs");
    expect(pluginNames).not.toContain("expo-speech-recognition");
    expect(config.ios?.infoPlist?.NSSpeechRecognitionUsageDescription).toBeUndefined();
  });
});
