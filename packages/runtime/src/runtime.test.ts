import { describe, expect, test } from "bun:test";
import { BTN, createGamepadController } from "./gamepad";
import { analyzeRgbaFrame, createInitialRoadModel, type VideoCaptureEngine } from "./vision";
import { computePidSteer, createGameplayOrchestrator } from "./controller";

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
    expect(gp.BTN).toBe(BTN);
  });

  test("pulseStick holds stick deflection briefly and always resets to (0, 0)", async () => {
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv();
    const observedAxes: number[][] = [];
    mockWindow.setTimeout = ((cb: TimerHandler, _ms?: number) => {
      const pad = mockNav.getGamepads()[0];
      if (pad) observedAxes.push([...pad.axes]);
      return globalThis.setTimeout(cb, 2);
    }) as unknown as typeof window.setTimeout;

    const gp = createGamepadController(mockWindow, mockNav, mockDoc);
    await gp.pulseStick(0, 0, 1, 20, 20);
    expect(observedAxes[0]).toEqual([0, 1, 0, 0]);
    expect(gp.getState().axes).toEqual([0, 0, 0, 0]);
    await expect(gp.pulseStick(2, 1, 0)).rejects.toThrow();
  });

  test("runChunk exposes api.BTN, unpauses before gas, snapshots pre-pause frame before START, and resets on error", async () => {
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv();
    const events: string[] = [];
    mockWindow.setTimeout = ((cb: TimerHandler, _ms?: number) => {
      const pad = mockNav.getGamepads()[0];
      if (pad) {
        const pressed = pad.buttons
          .map((b, i) => (b.pressed ? i : -1))
          .filter((i) => i >= 0);
        if (pressed.length > 0) events.push(`btn:${pressed.join(",")}`);
      }
      return globalThis.setTimeout(cb, 2);
    }) as unknown as typeof window.setTimeout;

    const gp = createGamepadController(mockWindow, mockNav, mockDoc);

    (globalThis as unknown as { window: unknown }).window = {
      setInterval: globalThis.setInterval.bind(globalThis),
      clearInterval: globalThis.clearInterval.bind(globalThis),
    };

    const fakeSurface = {} as HTMLCanvasElement;
    const fakeCapture = {
      resetTracking() {},
      findVideoSurface: () => fakeSurface,
      sampleAnalysis: () => ({
        motionScore: 0.05,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0,
        roadConfidence: 0.85,
        updatedRoadModel: createInitialRoadModel(),
      }),
      captureTile: (_s: unknown, tMs: number, axes: number[], buttons: number[]) => ({
        tMs,
        width: 320,
        height: 240,
        canvas: {} as HTMLCanvasElement,
        axes,
        buttons,
        motionScore: 0.05,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0,
        roadConfidence: 0.85,
      }),
      captureFullFrame: () => {
        events.push("prePauseSnapshot");
        return {} as HTMLCanvasElement;
      },
    } as unknown as VideoCaptureEngine;

    const orch = createGameplayOrchestrator(gp, fakeCapture);

    const okRes = await orch.runChunk(
      async ({ api }) => {
        api.setButton(api.BTN.RB, 1);
        await api.sleep(10);
        api.setButton(api.BTN.RB, 0);
      },
      {
        holdGasButton: gp.BTN.Y,
        unpauseSettleMs: 10,
        pauseSettleMs: 10,
        showSheetOverlay: false,
      },
    );

    expect(okRes.ok).toBe(true);
    // 1) Unpause BTN.A (0) held alone BEFORE gas BTN.Y (3)
    expect(events[0]).toBe(`btn:${BTN.A}`);
    // 2) Gas BTN.Y (3) + callback BTN.RB (5) held together during active body
    expect(events).toContain(`btn:${BTN.Y},${BTN.RB}`);
    // 3) Pre-pause HUD/minimap snapshot captured BEFORE pause BTN.START (9)
    const snapIdx = events.indexOf("prePauseSnapshot");
    const pauseIdx = events.findIndex((e) => e.startsWith("btn:") && e.includes(String(BTN.START)));
    expect(snapIdx).toBeGreaterThan(0);
    expect(pauseIdx).toBeGreaterThan(snapIdx);
    expect(gp.getState().buttons.every((v) => v === 0)).toBe(true);

    // Even if callback throws while holding brake/stick, finally resets everything
    const errRes = await orch.runChunk(
      async ({ api }) => {
        api.setButton(api.BTN.X, 1);
        api.setStick(0, -0.9, 0);
        throw new Error("boom");
      },
      { unpause: false, pause: false, showSheetOverlay: false },
    );

    expect(errRes.ok).toBe(false);
    expect(errRes.stopReason).toBe("error");
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

  test("steers decisively on brown dirt curves beside yellow desert sand without self-poisoning", () => {
    const w = 160;
    const h = 120;
    // Brown dirt road curving sharply right in lookahead band while surrounded by pale yellow desert sand
    const dirtRightNextToSand = makeTestFrame(w, h, (x, y) => {
      if (y < 42) return [115, 180, 242]; // sky
      const center = y < 72 ? w * 0.78 : w * 0.5;
      const halfRoad = 24;
      if (Math.abs(x - center) < halfRoad) return [148, 98, 48]; // Hacienda brown dirt road
      return [220, 202, 140]; // pale yellow desert sand
    });

    const curveRes = analyzeRgbaFrame(dirtRightNextToSand, null, w, h, {
      r: 148,
      g: 98,
      b: 48,
      initialized: true,
    });
    // Thresholded centroid prevents left sand from diluting right-hand steering offset
    expect(curveRes.roadOffsetX).toBeGreaterThan(0.45);
    expect(curveRes.roadConfidence).toBeGreaterThan(0.5);

    // Pure desert sand off-track frame drops roadConfidence < 0.15 and never poisons roadModel
    const pureSand = makeTestFrame(w, h, (_x, y) =>
      y < 42 ? [115, 180, 242] : [220, 202, 140],
    );
    let model = { r: 148, g: 98, b: 48, initialized: true };
    for (let i = 0; i < 15; i++) {
      const sandRes = analyzeRgbaFrame(pureSand, null, w, h, model);
      expect(sandRes.roadConfidence).toBeLessThan(0.15);
      model = sandRes.updatedRoadModel;
    }
    expect(model.r).toBeCloseTo(148, 2);
    expect(model.g).toBeCloseTo(98, 2);
    expect(model.b).toBeCloseTo(48, 2);
  });

  test("rejects vertical beige canyon walls while preserving dark-roofed archway tunnels", () => {
    const w = 160;
    const h = 120;
    const stoneModel = { r: 142, g: 138, b: 130, initialized: true };

    // Beige rock canyon wall spans across horizon (y: 16..90) with uniform warm rock color
    const canyonWall = makeTestFrame(w, h, (_x, y) => {
      if (y < 14) return [115, 180, 242];
      return y < 45 ? [156, 141, 116] : [151, 136, 112];
    });
    const wallRes = analyzeRgbaFrame(canyonWall, null, w, h, stoneModel);
    expect(wallRes.roadConfidence).toBeLessThan(0.15);

    // Covered tunnel has dark wooden rafters above horizon (lum ~42) over grey stone road
    const coveredTunnel = makeTestFrame(w, h, (x, y) => {
      if (y < 44) return [58, 42, 26]; // dark wooden tunnel ceiling
      if (x > 28 && x < 132) return [142, 138, 130]; // grey cobblestone tunnel floor
      return [218, 214, 204]; // bright white side plaster walls
    });
    const tunnelRes = analyzeRgbaFrame(coveredTunnel, null, w, h, stoneModel);
    expect(tunnelRes.roadConfidence).toBeGreaterThan(0.65);
    expect(Math.abs(tunnelRes.roadOffsetX)).toBeLessThan(0.15);
  });

  test("detects outlined orange-gold WRONG WAY! warning without false-triggering on canary chevrons", () => {
    const w = 160;
    const h = 120;
    // Outlined orange-gold "WRONG WAY!" strokes in y: 28..38, x: 52..108
    const wrongWayFrame = makeTestFrame(w, h, (x, y) => {
      if (y >= 28 && y <= 38 && x >= 52 && x <= 108) {
        return (x + y) % 3 === 0 ? [22, 18, 15] : [235, 142, 25];
      }
      return y < 44 ? [115, 180, 242] : [148, 98, 48];
    });
    const wwRes = analyzeRgbaFrame(wrongWayFrame, null, w, h);
    expect(wwRes.redAlertRatio).toBeGreaterThanOrEqual(0.035);

    // Canary yellow wall chevrons (R ~230, G ~222, B ~25) should NOT trigger WRONG WAY! redAlert
    const chevronFrame = makeTestFrame(w, h, (x, y) => {
      if (y >= 28 && y <= 38 && x >= 52 && x <= 108) {
        return x % 6 < 3 ? [20, 20, 20] : [230, 222, 25];
      }
      return y < 44 ? [115, 180, 242] : [148, 98, 48];
    });
    const chevRes = analyzeRgbaFrame(chevronFrame, null, w, h);
    expect(chevRes.redAlertRatio).toBeLessThan(0.01);
  });
});
