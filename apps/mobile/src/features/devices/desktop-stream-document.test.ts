import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";

import { deviceStreamDocument, deviceStreamMessage } from "./device-stream-document";
import { desktopDisconnectOutcome } from "./desktop-stream-document";

describe("native desktop stream", () => {
  it("keeps the password and ticket from terminating the embedded script", () => {
    const configuration = JSON.stringify({
      url: "wss://host/x?wsTicket=</script><b>",
      password: '</script><script>alert("pw")</script>',
    });
    const html = deviceStreamDocument(
      configuration,
      "var RoveDesktopStream={start(input){return input}};",
      "RoveDesktopStream",
    );
    expect(html.match(/<script>/g)).toHaveLength(1);
    const script = html.match(/<script>([\s\S]*)<\/script>/)![1]!;
    expect(NodeVM.runInNewContext(script, { window: { addEventListener() {} } })).toEqual({
      url: "wss://host/x?wsTicket=</script><b>",
      password: '</script><script>alert("pw")</script>',
    });
  });

  it("understands the status and unauthorized messages the desktop script posts", () => {
    expect(deviceStreamMessage('{"type":"unauthorized"}')).toEqual({ type: "unauthorized" });
    expect(deviceStreamMessage('{"type":"status","status":"streaming"}')).toMatchObject({
      status: "streaming",
    });
    expect(
      deviceStreamMessage('{"type":"status","status":"error","detail":"refused"}'),
    ).toMatchObject({ status: "error", detail: "refused" });
    expect(deviceStreamMessage("not json")).toBeNull();
  });

  it("refreshes an expired ticket once, then surfaces the refusal", () => {
    expect(
      desktopDisconnectOutcome({ connected: false, hasTicket: true, ticketRefreshed: false }),
    ).toBe("refresh-ticket");
    expect(
      desktopDisconnectOutcome({ connected: false, hasTicket: true, ticketRefreshed: true }),
    ).toBe("refused");
    expect(
      desktopDisconnectOutcome({ connected: false, hasTicket: false, ticketRefreshed: false }),
    ).toBe("refused");
    expect(
      desktopDisconnectOutcome({ connected: true, hasTicket: true, ticketRefreshed: false }),
    ).toBe("disconnected");
  });
});
