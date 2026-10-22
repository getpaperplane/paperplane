import { describe, expect, it } from "vite-plus/test";

import {
  parseMaxDeliveryAge,
  webhookDeliveryHeaderLines,
  webhookDeliveryOutcomeTone,
  webhookSignatureForUpsert,
  webhookSignatureIncomplete,
} from "./scheduledTaskWebhook.ts";

describe("parseMaxDeliveryAge", () => {
  it("treats blank as no limit and rejects values the server would not accept", () => {
    expect(parseMaxDeliveryAge("")).toBeNull();
    expect(parseMaxDeliveryAge(" 45 ")).toBe(45);
    for (const invalid of ["0", "1.5", "-3", "abc", "1441"]) {
      expect(parseMaxDeliveryAge(invalid)).toBeUndefined();
    }
  });
});

describe("webhook signature payload", () => {
  const base = {
    enabled: true,
    header: " x-sig ",
    encoding: "hex",
    prefix: "sha256=",
    secret: "",
  } as const;

  it("omits a blank secret, trims a typed one, and sends null when disabled", () => {
    expect(webhookSignatureForUpsert(base)).toEqual({
      header: "x-sig",
      encoding: "hex",
      prefix: "sha256=",
    });
    expect(webhookSignatureForUpsert({ ...base, secret: " s " })).toMatchObject({ secret: "s" });
    expect(webhookSignatureForUpsert({ ...base, enabled: false, secret: "s" })).toBeNull();
  });

  it("requires a header and either a typed or stored secret", () => {
    expect(webhookSignatureIncomplete(webhookSignatureForUpsert(base), false)).toBe(true);
    expect(webhookSignatureIncomplete(webhookSignatureForUpsert(base), true)).toBe(false);
    expect(
      webhookSignatureIncomplete(webhookSignatureForUpsert({ ...base, secret: "s" }), false),
    ).toBe(false);
    expect(
      webhookSignatureIncomplete(
        webhookSignatureForUpsert({ ...base, header: " ", secret: "s" }),
        true,
      ),
    ).toBe(true);
    expect(webhookSignatureIncomplete(null, false)).toBe(false);
  });
});

describe("webhook delivery display", () => {
  it("classifies outcomes", () => {
    expect(webhookDeliveryOutcomeTone("accepted")).toBe("success");
    expect(webhookDeliveryOutcomeTone("expired")).toBe("warning");
    expect(webhookDeliveryOutcomeTone("rejected_signature")).toBe("error");
    expect(webhookDeliveryOutcomeTone("dispatch_failed")).toBe("error");
  });

  it("masks the configured signature header in addition to server redaction", () => {
    expect(webhookDeliveryHeaderLines({ "X-Sig": "abc", "content-type": "json" }, "x-sig")).toEqual(
      ["X-Sig: [redacted]", "content-type: json"],
    );
    expect(webhookDeliveryHeaderLines({ "x-sig": "abc" }, null)).toEqual(["x-sig: abc"]);
  });
});
