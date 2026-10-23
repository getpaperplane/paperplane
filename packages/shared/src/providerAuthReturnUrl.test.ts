import { describe, expect, it } from "vite-plus/test";
import { providerAuthReturnUrl } from "./providerAuthReturnUrl.ts";

describe("provider auth return destinations", () => {
  it.each(["rove", "rove-dev"])(
    "returns to %s Welcome and the selected settings instance",
    (scheme) => {
      expect(providerAuthReturnUrl(`${scheme}://app/welcome?code=secret#agents:machine-id`)).toBe(
        `${scheme}://app/welcome#agents:machine-id`,
      );
      expect(
        providerAuthReturnUrl(`${scheme}://app/settings/providers?instanceId=work&code=secret`),
      ).toBe(`${scheme}://app/settings/providers?instanceId=work`);
    },
  );
  it("returns to the hosted Paperplane client and strips OAuth credentials", () => {
    expect(
      providerAuthReturnUrl(
        "https://rove.hafiezulzikry.com/settings/providers?environmentId=remote&instanceId=work&code=secret#token",
      ),
    ).toBe(
      "https://rove.hafiezulzikry.com/settings/providers?environmentId=remote&instanceId=work",
    );
  });
  it.each([
    "https://app.t3.codes/welcome",
    "http://rove.hafiezulzikry.com/welcome",
    "https://rove.hafiezulzikry.com.attacker.example/welcome",
    "https://rove.hafiezulzikry.com:123/welcome",
    "rove://attacker/welcome",
    "rove://app:123/welcome",
    "rove://app/auth/callback",
    "rove://user@ app/welcome",
    "rove://app/welcome/../evil",
    "https://attacker.example/welcome",
    "file:///welcome",
    "javascript:alert(1)",
  ])("rejects %s", (url) => expect(providerAuthReturnUrl(url)).toBeUndefined());
});
