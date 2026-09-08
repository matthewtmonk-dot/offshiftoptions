import { describe, expect, it } from "vitest";
import { schwabPrimaryConnectionAction } from "./broker-connections";

describe("schwabPrimaryConnectionAction", () => {
  it("never connected -> Connect", () => {
    expect(schwabPrimaryConnectionAction("NOT_CONNECTED")).toBe("CONNECT");
  });

  it("healthy connected -> Disconnect", () => {
    expect(schwabPrimaryConnectionAction("CONNECTED")).toBe("DISCONNECT");
  });

  it("refresh failed -> Reconnect", () => {
    expect(schwabPrimaryConnectionAction("REFRESH_FAILED")).toBe("RECONNECT");
  });

  it("token expired -> Reconnect", () => {
    expect(schwabPrimaryConnectionAction("TOKEN_EXPIRED")).toBe("RECONNECT");
  });
});
