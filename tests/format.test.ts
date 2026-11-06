import { describe, expect, it } from "vitest";
import { fmtClock, fmtElapsed, fmtTime } from "../src/ui/format";

describe("HUD time formats", () => {
  it("counts down in whole seconds, up in whole seconds, and reports tenths", () => {
    expect(fmtClock(40)).toBe("0:40");
    expect(fmtClock(39.01)).toBe("0:40");
    expect(fmtClock(0)).toBe("0:00");
    expect(fmtClock(75)).toBe("1:15");
    expect(fmtElapsed(0)).toBe("0:00");
    expect(fmtElapsed(59.99)).toBe("0:59");
    expect(fmtElapsed(60)).toBe("1:00");
    expect(fmtElapsed(-3)).toBe("0:00");
    expect(fmtTime(23.44)).toBe("0:23.4");
    expect(fmtTime(61.07)).toBe("1:01.1");
    expect(fmtTime(59.96)).toBe("1:00.0");
  });
});
