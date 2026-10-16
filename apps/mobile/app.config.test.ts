import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const configEnv = vi.hoisted(() => ({ current: {} }));
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => configEnv.current,
}));

const originalEnv = { ...process.env };
const configuredKeys = [
  "APP_VARIANT",
  "ROVE_CLOUD_READY",
  "ROVE_RELAY_URL",
  "EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY",
  "EXPO_PUBLIC_CLERK_JWT_TEMPLATE",
  "EXPO_PUBLIC_CLERK_GOOGLE_WEB_CLIENT_ID",
  "ROVE_EXPO_PROJECT_ID",
  "ROVE_EXPO_OWNER",
  "ROVE_MOBILE_UPDATES_ENABLED",
  "ROVE_APPLE_TEAM_ID",
  "ROVE_CLERK_RELYING_PARTY_DOMAIN",
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
      ROVE_CLOUD_READY: "1",
      ROVE_EXPO_PROJECT_ID: "00000000-0000-4000-8000-000000000000",
      ROVE_EXPO_OWNER: "rove-test",
      ROVE_MOBILE_UPDATES_ENABLED: "1",
      ROVE_APPLE_TEAM_ID: "ABCDE12345",
      ROVE_CLERK_RELYING_PARTY_DOMAIN: "rove.example.test",
    });
    expect(config.updates?.enabled).toBe(true);
    expect(config.updates?.url).toBe("https://u.expo.dev/00000000-0000-4000-8000-000000000000");
    expect(config.extra?.eas).toEqual({ projectId: "00000000-0000-4000-8000-000000000000" });
    expect(config.owner).toBe("rove-test");
    expect(config.ios?.appleTeamId).toBe("ABCDE12345");
    expect(config.ios?.associatedDomains).toEqual([
      "applinks:rove.example.test",
      "webcredentials:rove.example.test",
    ]);
  });

  it.each([undefined, "0", "1"])(
    "gates configured Rove Connect infrastructure (%s)",
    async (gate) => {
      const config = await configFor({
        ...(gate ? { ROVE_CLOUD_READY: gate } : undefined),
        ROVE_RELAY_URL: "https://relay.example.test",
        EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_example",
        EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "rove-relay",
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
    ["development", "Rove Code Dev", "dev.rove.app.dev"],
    ["preview", "Rove Code Preview", "dev.rove.app.preview"],
    ["production", "Rove Code", "dev.rove.app"],
  ])("retains the %s Rove app identity", async (variant, name, id) => {
    const config = await configFor({ APP_VARIANT: variant });
    expect(config.name).toBe(name);
    expect(config.ios?.bundleIdentifier).toBe(id);
    expect(config.android?.package).toBe(id);
  });

  it("refuses OTA updates without a project ID", async () => {
    await expect(configFor({ ROVE_MOBILE_UPDATES_ENABLED: "1" })).rejects.toThrow(
      "ROVE_EXPO_PROJECT_ID is required",
    );
  });

  it("refuses upstream relying-party domains even if explicitly configured", async () => {
    await expect(
      configFor({ ROVE_CLOUD_READY: "1", ROVE_CLERK_RELYING_PARTY_DOMAIN: "clerk.t3.codes" }),
    ).rejects.toThrow("must belong to this project");
  });
});
