import { describe, expect, it, vi } from "vitest";
import { OrbitCamera } from "../src/preview/orbit";

// A stand-in canvas: an EventTarget with the few element members OrbitCamera uses, in a "window" that can blur.
function setup() {
  const win = new EventTarget();
  const doc = { pointerLockElement: null as unknown, defaultView: win };
  const el = Object.assign(new EventTarget(), { clientHeight: 600, ownerDocument: doc, setPointerCapture: vi.fn() });
  const cam = new OrbitCamera(), moved = vi.fn();
  const detach = cam.attach(el as unknown as HTMLElement, moved);
  const send = (type: string, init: Record<string, unknown> = {}, target: EventTarget = el) => {
    const e = Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, shiftKey: false, deltaY: 0, ...init });
    target.dispatchEvent(e);
    return e;
  };
  return { cam, el, win, doc, moved, detach, send };
}

describe("OrbitCamera input", () => {
  it("clamps wheel zoom to its distance limits, 0.3–80 m unless a caller widens them", () => {
    const { cam, send } = setup();
    expect([cam.minDistance, cam.maxDistance]).toEqual([0.3, 80]);
    send("wheel", { deltaY: 100000 });
    expect(cam.distance).toBe(80);
    send("wheel", { deltaY: -100000 });
    expect(cam.distance).toBe(0.3);
    cam.maxDistance = 600;
    send("wheel", { deltaY: 100000 });
    expect(cam.distance).toBe(600);
  });

  it("leaves refused events alone and ends a drag the gate refuses mid-way", () => {
    const win = new EventTarget();
    const el = Object.assign(new EventTarget(), { clientHeight: 600, ownerDocument: { pointerLockElement: null, defaultView: win }, setPointerCapture: vi.fn() });
    const cam = new OrbitCamera();
    let open = false;
    cam.attach(el as unknown as HTMLElement, () => {}, () => open);
    const send = (type: string, init: Record<string, unknown> = {}) => {
      const e = Object.assign(new Event(type, { cancelable: true }), { pointerId: 1, clientX: 0, clientY: 0, buttons: 1, deltaY: 0, ...init });
      el.dispatchEvent(e);
      return e;
    };
    const yaw = cam.yaw, distance = cam.distance;
    expect(send("wheel", { deltaY: 500 }).defaultPrevented).toBe(false);
    send("pointerdown");
    send("pointermove", { clientX: 50 });
    expect([cam.yaw, cam.distance]).toEqual([yaw, distance]);
    expect(el.setPointerCapture).not.toHaveBeenCalled();
    open = true;
    send("pointerdown", { clientX: 50 });
    send("pointermove", { clientX: 100 });
    expect(cam.yaw).toBeLessThan(yaw);
    const turned = cam.yaw;
    open = false;
    send("pointermove", { clientX: 150 }); // refused: the drag ends here
    open = true;
    send("pointermove", { clientX: 200 }); // no pointer is down any more
    expect(cam.yaw).toBe(turned);
  });

  it("drops held pointers when the window loses focus", () => {
    const { cam, win, send } = setup();
    send("pointerdown");
    send("pointermove", { clientX: 40 });
    const turned = cam.yaw;
    send("blur", {}, win);
    send("pointermove", { clientX: 80 });
    expect(cam.yaw).toBe(turned);
  });

  it("does not capture the pointer while it is locked (setPointerCapture throws InvalidStateError then)", () => {
    const { cam, el, doc, send } = setup();
    doc.pointerLockElement = el;
    el.setPointerCapture.mockImplementation(() => { throw new DOMException("locked", "InvalidStateError"); });
    expect(() => send("pointerdown")).not.toThrow();
    send("pointermove", { clientX: 40 });
    expect(cam.yaw).not.toBe(0.6);
    doc.pointerLockElement = null;
    el.setPointerCapture.mockReset();
    send("pointerup");
    send("pointerdown", { pointerId: 2 });
    expect(el.setPointerCapture).toHaveBeenCalledWith(2);
  });

  it("removes its listeners when detached", () => {
    const { cam, detach, send, moved } = setup();
    detach();
    send("wheel", { deltaY: 500 });
    send("pointerdown");
    send("pointermove", { clientX: 40 });
    expect([cam.distance, cam.yaw]).toEqual([4, 0.6]);
    expect(moved).not.toHaveBeenCalled();
  });
});
