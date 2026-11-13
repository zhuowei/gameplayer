import { describe, expect, test } from "bun:test";
import { BTN, createGamepadController } from "./gamepad";
import { analyzeRgbaFrame, createInitialRoadModel } from "./vision";
import { computePidSteer } from "./controller";

function createMockBrowserEnv(readyState: DocumentReadyState = "complete") {
  const listeners = new Map<string, Array<(ev: unknown) => void>>();
  const dispatched: Array<{ type: string; gamepad?: Gamepad }> = [];

  const mockWindow = {
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    addEventListener(type: string, cb: (ev: unknown) => void) {
      const list = listeners.get(type) ?? [];
      list.push(cb);
      listeners.set(type, list);
    },
    dispatchEvent(ev: Event & { gamepad?: Gamepad }) {
      dispatched.push({ type: ev.type, gamepad: ev.gamepad });
      for (const cb of listeners.get(ev.type) ?? []) cb(ev);
      return true;
    },
  } as unknown as Window & typeof globalThis;

  const mockNav = { getGamepads: () => [] } as unknown as Navigator;
  const mockDoc = { readyState } as unknown as Document;

  return { mockWindow, mockNav, mockDoc, dispatched, listeners };
}

function makeTestFrame(
  width: number,
  height: number,
  painter: (x: number, y: number) => [number, number, number],
): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = painter(x, y);
      const idx = (y * width + x) * 4;
      rgba[idx] = r;
      rgba[idx + 1] = g;
      rgba[idx + 2] = b;
      rgba[idx + 3] = 255;
    }
  }
  return rgba;
}

describe("gamepad controller", () => {
  test("dispatches gamepadconnected immediately when document already loaded", () => {
    const { mockWindow, mockNav, mockDoc, dispatched } = createMockBrowserEnv("complete");
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);
    expect(dispatched.length).toBe(1);
    expect(dispatched[0].type).toBe("gamepadconnected");
    expect(dispatched[0].gamepad).toBe(gp.simGamepad);
    expect(mockNav.getGamepads()[0]).toBe(gp.simGamepad);
  });

  test("waits for load event when injected while document is still loading", () => {
    const { mockWindow, mockNav, mockDoc, dispatched } = createMockBrowserEnv("loading");
    createGamepadController(mockWindow, mockNav, mockDoc);
    expect(dispatched.length).toBe(0);
    mockWindow.dispatchEvent(new Event("load"));
    const gpEvents = dispatched.filter((e) => e.type === "gamepadconnected");
    expect(gpEvents.length).toBe(1);
  });

  test("rejects out-of-bounds stick index >= 2 (fixes off-by-one)", () => {
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv();
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);
    expect(() => gp.setStick(0, 0.5, -0.5)).not.toThrow();
    expect(() => gp.setStick(1, -1, 1)).not.toThrow();
    expect(() => gp.setStick(2, 0, 0)).toThrow();
    expect(() => gp.setStick(-1, 0, 0)).toThrow();
  });

  test("clamps values, supports rampStick, and resets all inputs", async () => {
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv();
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);
    gp.setButton(BTN.Y, 1.8);
    expect(gp.getState().buttons[BTN.Y]).toBe(1);
    expect(gp.simGamepad.buttons[BTN.Y].pressed).toBe(true);

    await gp.rampStick(0, -0.8, 0.2, 20, 4);
    expect(gp.getState().axes[0]).toBeCloseTo(-0.8, 4);
    expect(gp.getState().axes[1]).toBeCloseTo(0.2, 4);

    gp.resetAll();
    expect(gp.getState().axes).toEqual([0, 0, 0, 0]);
    expect(gp.getState().buttons.every((v) => v === 0)).toBe(true);
  });
});

describe("vision & PID servo", () => {
  test("detects road curving right vs left against green grass", () => {
    const w = 160;
    const h = 120;
    // Road shifts right in upper lookahead band (y < 70)
    const rightCurve = makeTestFrame(w, h, (x, y) => {
      if (y < 45) return [110, 175, 240]; // sky
      const center = y < 70 ? w * 0.72 : w * 0.5;
      const halfRoad = 26;
      if (Math.abs(x - center) < halfRoad) return [130, 125, 118]; // gray/brown road
      return [45, 155, 45]; // green grass
    });

    const res = analyzeRgbaFrame(rightCurve, null, w, h, createInitialRoadModel());
    expect(res.roadOffsetX).toBeGreaterThan(0.25);
    expect(res.roadConfidence).toBeGreaterThan(0.35);

    const leftCurve = makeTestFrame(w, h, (x, y) => {
      if (y < 45) return [110, 175, 240];
      const center = y < 70 ? w * 0.28 : w * 0.5;
      const halfRoad = 26;
      if (Math.abs(x - center) < halfRoad) return [130, 125, 118];
      return [45, 155, 45];
    });

    const resLeft = analyzeRgbaFrame(leftCurve, null, w, h, createInitialRoadModel());
    expect(resLeft.roadOffsetX).toBeLessThan(-0.25);
  });

  test("detects static stuck frame vs moving frame and red warning alert", () => {
    const w = 160;
    const h = 120;
    const f1 = makeTestFrame(w, h, (x, y) => [100, 100, 100]);
    const identical = analyzeRgbaFrame(f1, f1, w, h);
    expect(identical.motionScore).toBe(0);

    const f2 = makeTestFrame(w, h, (x, y) => {
      if (y >= 12 && y <= 32 && x >= 45 && x <= 115) return [245, 25, 25];
      return [180, 180, 180];
    });
    const moved = analyzeRgbaFrame(f2, f1, w, h);
    expect(moved.motionScore).toBeGreaterThan(0.2);
    expect(moved.bannerDelta).toBeGreaterThan(0.5);
    expect(moved.redAlertRatio).toBeGreaterThan(0.2);
  });

  test("PID steering applies slew-rate limiting and bounds", () => {
    const s1 = computePidSteer(1.0, { prevError: 0, prevSteer: 0 }, 0.033);
    expect(s1.steer).toBeGreaterThan(0);
    expect(s1.steer).toBeLessThanOrEqual(0.85);
    // Slew rate 4.5 * 0.033 ~= 0.1485 max step from 0
    expect(s1.steer).toBeCloseTo(4.5 * 0.033, 4);
  });
});
