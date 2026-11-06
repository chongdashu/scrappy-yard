import { describe, expect, it } from "vitest";
import { purchaseGate } from "../src/purchase-gate";

describe("purchaseGate", () => {
  it("web guests must sign in", () => expect(purchaseGate("web", false)).toBe("signin"));
  it("web signed-in can buy", () => expect(purchaseGate("web", true)).toBe("ok"));
  it("wavedash defers to host (no Convex OAuth)", () => expect(purchaseGate("wavedash", false)).toBe("ok"));
});
