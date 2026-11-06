// On-screen touch buttons (src/ui/touch-buttons.ts) on a fake DOM: showing and hiding one button (setShown), and
// letting go of a held action when its button is hidden under the finger.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TouchButtons } from "../src/ui/touch-buttons";
import type { Input } from "../src/input";

class FakeEl {
  hidden = false;
  className = "";
  type = "";
  textContent = "";
  dataset: Record<string, string> = {};
  children: FakeEl[] = [];
  private classes = new Set<string>();
  private listeners = new Map<string, ((e: unknown) => void)[]>();
  classList = {
    add: (c: string) => this.classes.add(c),
    remove: (c: string) => this.classes.delete(c),
    toggle: (c: string, on?: boolean) => ((on ?? !this.classes.has(c)) ? this.classes.add(c) : this.classes.delete(c)),
    contains: (c: string) => this.classes.has(c),
  };
  get firstElementChild() {
    return this.children[0] ?? null;
  }
  setAttribute() {}
  setPointerCapture() {}
  append(...els: FakeEl[]) {
    this.children.push(...els);
  }
  addEventListener(type: string, fn: (e: unknown) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }
  fire(type: string, e: object) {
    for (const fn of this.listeners.get(type) ?? []) fn({ preventDefault() {}, ...e });
  }
}

beforeEach(() => vi.stubGlobal("document", { createElement: () => new FakeEl() }));
afterEach(() => vi.unstubAllGlobals());

function setup(over: object = {}) {
  const input = {
    touchEver: true,
    emulateTouch: false,
    get touchControls() {
      return this.touchEver || this.emulateTouch; // (Input's own rule, less the coarse pointer)
    },
    buttonDown: vi.fn(),
    buttonUp: vi.fn(),
    ...over,
  };
  const parent = new FakeEl();
  const buttons = new TouchButtons(input as unknown as Input, [{ action: "use", label: "USE", size: "large" }, { action: "brake", label: "BRAKE" }], parent as unknown as HTMLElement);
  const root = parent.children[0];
  const button = (action: string) => root.children.find((b) => b.dataset.action === action)!;
  return { input, buttons, root, button };
}

describe("TouchButtons", () => {
  it("setShown hides and shows one button, leaving the others and the layer alone", () => {
    const { buttons, root, button } = setup();
    buttons.update(true);
    expect(root.hidden).toBe(false);
    buttons.setShown("brake", false);
    expect(button("brake").hidden).toBe(true);
    expect(button("use").hidden).toBe(false);
    buttons.setShown("brake", true);
    expect(button("brake").hidden).toBe(false);
    buttons.setShown("nope", false); // unknown: ignored
    expect(root.hidden).toBe(false);
  });

  it("hiding a button a finger holds lets its action go, once", () => {
    const { input, buttons, button } = setup();
    button("brake").fire("pointerdown", { pointerId: 7 });
    expect(input.buttonDown).toHaveBeenCalledWith(7, "brake");
    expect(button("brake").classList.contains("down")).toBe(true);
    buttons.setShown("brake", false);
    expect(input.buttonUp).toHaveBeenCalledWith(7);
    expect(button("brake").classList.contains("down")).toBe(false);
    buttons.setShown("brake", false);
    button("brake").fire("pointerup", { pointerId: 7 }); // the finger lifting later
    buttons.setShown("brake", true);
    buttons.setShown("brake", false);
    expect(input.buttonUp).toHaveBeenCalledTimes(2); // once from hiding, once from the real pointerup; nothing more
  });

  it("a released button is not released again when hidden", () => {
    const { input, buttons, button } = setup();
    button("use").fire("pointerdown", { pointerId: 3 });
    button("use").fire("pointerup", { pointerId: 3 });
    buttons.setShown("use", false);
    expect(input.buttonUp).toHaveBeenCalledTimes(1);
  });

  it("shows on a desktop that has had no touch while Input.emulateTouch is on, and only in play", () => {
    const off = setup({ touchEver: false });
    off.buttons.update(true);
    expect(off.root.hidden).toBe(true);
    const on = setup({ touchEver: false, emulateTouch: true });
    on.buttons.update(true);
    expect(on.root.hidden).toBe(false);
    on.buttons.update(false);
    expect(on.root.hidden).toBe(true);
  });
});
