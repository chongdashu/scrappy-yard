// The dev Mobile view's window: which page it opens and its size (src/dev/mobile-view.ts). The window itself is
// checked in a browser by tests/mobile-view.mjs.
import { describe, expect, it } from "vitest";
import { MOBILE_VIEW_NAME, viewFeatures, viewSize, viewUrl } from "../src/dev/mobile-view";

describe("Mobile view", () => {
  it("opens this page in play while a round is, at the menu otherwise, and never in capture mode", () => {
    expect(viewUrl("http://localhost:5173/?scene=arena&capture", true)).toBe("http://localhost:5173/?scene=arena&autostart=");
    expect(viewUrl("http://localhost:5173/?autostart&mobileView", false)).toBe("http://localhost:5173/");
  });
  it("is a landscape phone by default; portrait swaps the sides", () => {
    expect(viewSize(false)).toEqual([844, 390]);
    expect(viewSize(true)).toEqual([390, 844]);
  });
  it("opens at the main window's right edge, never off the screen", () => {
    expect(viewFeatures(false, { screenX: 100, screenY: 50, outerWidth: 1400 })).toBe("popup=yes,width=844,height=390,left=632,top=130,resizable=yes");
    expect(viewFeatures(true, { screenX: 0, screenY: 0, outerWidth: 300 })).toContain("left=0,top=80");
  });
  it("names its window as main.ts expects", async () => {
    const main = await import("node:fs").then((fs) => fs.readFileSync(new URL("../src/main.ts", import.meta.url), "utf8"));
    expect(main).toContain(`window.name === "${MOBILE_VIEW_NAME}"`);
  });
});
