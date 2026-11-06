import { describe, expect, it } from "vitest";
import { Camera, eyeAsShot, type EyePose } from "../src/camera";
import { mat4 } from "../src/math";

describe("Camera", () => {
  it("picks the ground point it projects (stable camera, no shake)", () => {
    const cam = new Camera();
    cam.update(1 / 60, 2, -3, 16 / 9, [-10, -10, 10, 10]);
    for (const [x, z] of [[2, -3], [0, 0], [4, 1]]) {
      const s = cam.project([x, 0, z], 1280, 720)!;
      const g = cam.pickGround(s[0], s[1], 1280, 720)!;
      expect(g[0]).toBeCloseTo(x, 3);
      expect(g[1]).toBeCloseTo(z, 3);
    }
  });
  it("screen up is world −Z and right is +X in the gameplay view", () => {
    const { right, up } = new Camera().groundBasis();
    expect(right[0]).toBeCloseTo(1);
    expect(right[1]).toBeCloseTo(0);
    expect(up[0]).toBeCloseTo(0);
    expect(up[1]).toBeCloseTo(-1);
  });
  it("frames portrait by width and landscape by height", () => {
    const cam = new Camera({ portraitWidth: 10, landscapeHeight: 11 });
    const t = Math.tan(cam.fovY / 2);
    expect(cam.frameFor(0.5)).toBeCloseTo(10 / (2 * t * 0.5), 5);
    expect(cam.frameFor(16 / 9)).toBeCloseTo(11 / (2 * t), 5);
  });
  it("keeps a large scene inside clip depth when a shot pulls back past 200 m", () => {
    const cam = new Camera();
    cam.shot = { target: [0, 2, 0], yaw: 0.55, pitch: 0.24, distance: 273 };
    cam.shotBlend = 1;
    cam.update(1 / 60, 0, 0, 390 / 844, [-100, -100, 100, 100]);
    for (const x of [-26.4, 26.4]) for (const z of [-26.4, 26.4]) {
      const clip = mat4.transformPoint(cam.viewProj, [x, 0, z]);
      expect(clip[2] / clip[3]).toBeGreaterThan(0);
      expect(clip[2] / clip[3]).toBeLessThan(1);
    }
  });
  it("keeps the 200 m far plane for ordinary framings", () => {
    const cam = new Camera();
    cam.update(1 / 60, 0, 0, 16 / 9, [-10, -10, 10, 10]);
    const far = cam.proj[14] / (cam.proj[10] + 1); // perspective(): m10 = f/(n−f), m14 = n·f/(n−f)
    expect(far).toBeCloseTo(200, 1); // float32 matrix
  });
});

describe("Camera, follow yaw (CameraRig.yaw)", () => {
  const bounds: [number, number, number, number] = [-2000, -2000, 2000, 2000];
  it("defaults to 0, so a rig without it frames as before", () => {
    const a = new Camera({ pitch: 0.9 }), b = new Camera({ pitch: 0.9, yaw: 0 });
    for (const cam of [a, b]) cam.update(1 / 60, 2, -3, 16 / 9, [-10, -10, 10, 10]);
    expect([...a.viewProj]).toEqual([...b.viewProj]);
    expect(a.gameplayShot().yaw).toBe(0);
  });
  it("yaw π looks along +Z from behind the focus: screen up and movement follow it", () => {
    const cam = new Camera({ yaw: Math.PI, pitch: Math.PI / 4 });
    cam.snap(0, 0, 1, bounds);
    cam.update(1, 0, 0, 1, bounds);
    expect(cam.eye[2]).toBeLessThan(0);
    const { right, up } = cam.groundBasis();
    expect(up[0]).toBeCloseTo(0);
    expect(up[1]).toBeCloseTo(1);
    expect(right[0]).toBeCloseTo(-1);
    const near = cam.project([0, 0, 0], 800, 800)!;
    const ahead = cam.project([0, 0, 3], 800, 800)!;
    const toRight = cam.project([-3, 0, 0], 800, 800)!;
    expect(ahead[1]).toBeLessThan(near[1]);
    expect(toRight[0]).toBeGreaterThan(near[0]);
    expect(cam.gameplayShot().yaw).toBe(Math.PI);
  });
  it("shifts the look point away from a top HUD band along the view, whatever the yaw", () => {
    const screenY = (yaw: number) => {
      const cam = new Camera({ yaw });
      cam.cover = [0.3, 0];
      cam.snap(1, 2, 16 / 9, bounds);
      cam.update(1 / 60, 1, 2, 16 / 9, bounds);
      return cam.project([1, 0, 2], 1280, 720)!;
    };
    const [x0, y0] = screenY(0);
    expect(y0).toBeGreaterThan(360 + 40); // pushed below the covered top band
    for (const yaw of [1.1, Math.PI, -2.3]) {
      const [x, y] = screenY(yaw);
      expect(x).toBeCloseTo(x0, 1);
      expect(y).toBeCloseTo(y0, 1);
    }
  });
  it("clamps the turned footprint to the bounds: a quarter turn swaps the view's depth onto x", () => {
    const narrow: [number, number, number, number] = [-50, -3, 50, 3];
    const at = (yaw: number) => {
      const cam = new Camera({ yaw, edgeMargin: 1 });
      cam.snap(0, 0, 16 / 9, narrow);
      return { cam, fp: cam.footprint(), focus: cam.clampFocus(49, 0, narrow) };
    };
    const zero = at(0), quarter = at(Math.PI / 2);
    expect(zero.focus[0]).toBeCloseTo(50 + 1 - zero.fp.half, 4);
    // Yaw π/2: the camera is on the +X side, so the near edge of its footprint lies toward +X.
    expect(quarter.focus[0]).toBeCloseTo(50 + 1 - quarter.fp.near, 4);
    // Across the view is now z: the level is narrower than the view there, so it is centred.
    expect(quarter.focus[1]).toBeCloseTo(0, 6);
  });
  it("shakes along the view's own axes: the same screen motion at any yaw", () => {
    const offsets = (yaw: number) => {
      const cam = new Camera({ yaw });
      cam.update(1 / 60, 0, 0, 16 / 9, [-10, -10, 10, 10]);
      const still = cam.project([0, 0, 0], 1280, 720)!;
      cam.addTrauma(1);
      cam.update(0.05, 0, 0, 16 / 9, [-10, -10, 10, 10]);
      const shaken = cam.project([0, 0, 0], 1280, 720)!;
      const top = cam.project([0, 1, 0], 1280, 720)!;
      return [shaken[0] - still[0], shaken[1] - still[1], top[0] - shaken[0]];
    };
    const ref = offsets(0);
    expect(Math.hypot(ref[0], ref[1])).toBeGreaterThan(1);
    for (const yaw of [0.7, Math.PI, -1.9]) offsets(yaw).forEach((v, i) => expect(v).toBeCloseTo(ref[i], 2));
  });
});

describe("Camera, first-person mode", () => {
  const eye: EyePose = { x: 1, y: 1.65, z: 4, yaw: Math.PI / 2 + 0.3, pitch: -0.2 };
  const fp = () => {
    const cam = new Camera({}, "first-person");
    cam.setEye(eye);
    cam.update(1 / 60, 0, 0, 16 / 9, [-1, -1, 1, 1]);
    return cam;
  };

  it("renders from exactly the eye the game gave it", () => {
    const cam = fp();
    expect(cam.eye[0]).toBeCloseTo(eye.x, 4);
    expect(cam.eye[1]).toBeCloseTo(eye.y, 4);
    expect(cam.eye[2]).toBeCloseTo(eye.z, 4);
    // The view direction is the yaw/pitch: a point along it projects to the middle of the screen.
    const f = [Math.sin(eye.yaw) * Math.cos(eye.pitch), Math.sin(eye.pitch), Math.cos(eye.yaw) * Math.cos(eye.pitch)];
    const s = cam.project([eye.x + f[0] * 5, eye.y + f[1] * 5, eye.z + f[2] * 5], 1280, 720)!;
    expect(s[0]).toBeCloseTo(640, 1);
    expect(s[1]).toBeCloseTo(360, 1);
    // Straight behind is not on screen.
    expect(cam.project([eye.x - f[0] * 5, eye.y, eye.z - f[2] * 5], 1280, 720)).toBeNull();
  });

  it("turning right (yaw down) moves the world left on screen; looking up moves it down", () => {
    const point: [number, number, number] = [eye.x + Math.sin(eye.yaw) * 5, eye.y, eye.z + Math.cos(eye.yaw) * 5];
    const before = fp().project(point, 1280, 720)!;
    const cam = new Camera({}, "first-person");
    cam.setEye({ ...eye, yaw: eye.yaw - 0.1 });
    cam.update(1 / 60, 0, 0, 16 / 9, [-1, -1, 1, 1]);
    expect(cam.project(point, 1280, 720)![0]).toBeLessThan(before[0]);
    cam.setEye({ ...eye, pitch: eye.pitch + 0.1 });
    cam.update(1 / 60, 0, 0, 16 / 9, [-1, -1, 1, 1]);
    expect(cam.project(point, 1280, 720)![1]).toBeGreaterThan(before[1]);
  });

  it("uses the eye's field of view and near plane, and hands the sun a shadow focus", () => {
    const cam = new Camera({ fovY: 1 }, "first-person");
    cam.setEye({ ...eye, fovY: 1.4 });
    cam.update(1 / 60, 0, 0, 1, [-1, -1, 1, 1]);
    expect(cam.fovY).toBe(1.4);
    expect(cam.shadowFocus).not.toBeNull();
    cam.setEye({ ...eye, shadowFocus: [3, -2] });
    cam.update(1 / 60, 0, 0, 1, [-1, -1, 1, 1]);
    expect(cam.shadowFocus).toEqual([3, -2]);
    expect(new Camera().shadowFocus).toBeNull();
  });

  it("screen up is where the player faces", () => {
    const { up, right } = fp().groundBasis();
    expect(up[0]).toBeCloseTo(Math.sin(eye.yaw), 6);
    expect(up[1]).toBeCloseTo(Math.cos(eye.yaw), 6);
    // Facing +Z (yaw 0): the player's right hand is −X.
    const c = new Camera({}, "first-person");
    c.setEye({ ...eye, yaw: 0 });
    expect(c.groundBasis().right[0]).toBeCloseTo(-1, 6);
  });

  it("expresses the eye as an orbit shot the flow can blend from, and blends toward a shot", () => {
    const s = eyeAsShot(eye);
    const cam = new Camera({}, "first-person");
    cam.setEye(eye);
    cam.shot = { ...s };
    cam.shotBlend = 1;
    cam.update(1 / 60, 0, 0, 16 / 9, [-1, -1, 1, 1]);
    expect(cam.eye[0]).toBeCloseTo(eye.x, 3);
    expect(cam.eye[2]).toBeCloseTo(eye.z, 3);
    cam.shot = { target: [0, 1, 0], pitch: 0.4, yaw: 0, distance: 6 };
    cam.shotBlend = 1;
    cam.update(1 / 60, 0, 0, 16 / 9, [-1, -1, 1, 1]);
    expect(Math.hypot(cam.eye[0], cam.eye[2] - 6 * Math.cos(0.4))).toBeLessThan(0.01);
    expect(cam.gameplayShot().distance).toBe(1);
    expect(new Camera().gameplayShot().pitch).toBeCloseTo(new Camera().rig.pitch, 6);
  });

  it("shake wobbles the aim but never the eye, and picking uses the unshaken view", () => {
    const calm = fp();
    const cam = new Camera({}, "first-person");
    cam.setEye(eye);
    cam.addTrauma(1);
    cam.update(0.2, 0, 0, 16 / 9, [-1, -1, 1, 1]);
    expect(cam.eye).toEqual(calm.eye);
    expect(Array.from(cam.view)).not.toEqual(Array.from(calm.view));
    expect(Array.from(cam.stableViewProj)).toEqual(Array.from(calm.stableViewProj));
  });
});
