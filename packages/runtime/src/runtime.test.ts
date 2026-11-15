import { describe, expect, test } from "bun:test";
import { BTN, createGamepadController } from "./gamepad";
import {
  analyzeGtavRadarRgba,
  analyzeGtavReticleRgba,
  analyzeMinimapRgba,
  analyzeRgbaFrame,
  createInitialRoadModel,
  detectRaceFinished,
  MinimapTracker,
  type VideoCaptureEngine,
} from "./vision";
import { analyzeDisparityMap, rgbaToNormalizedChwTensor, type DepthEngineLike } from "./depth";
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

  test("adopts Gamepad, GamepadButton, and GamepadEvent prototypes safely, uses performance.now timestamp, and returns 4-slot tuple", () => {
    class MockGamepadButton {
      get pressed(): boolean {
        throw new TypeError("Illegal invocation");
      }
      get extraGetter(): unknown {
        throw new TypeError("Illegal invocation");
      }
    }
    class MockGamepad {
      get id(): string {
        throw new TypeError("Illegal invocation");
      }
      get pose(): unknown {
        throw new TypeError("Illegal invocation");
      }
    }
    class MockGamepadEvent extends Event {
      get gamepad(): Gamepad {
        throw new TypeError("Illegal invocation");
      }
    }

    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv("complete");
    const winRec = mockWindow as unknown as Record<string, unknown>;
    winRec.GamepadButton = MockGamepadButton;
    winRec.Gamepad = MockGamepad;
    winRec.GamepadEvent = MockGamepadEvent;
    winRec.performance = { now: () => 4242.5 };

    const received: unknown[] = [];
    mockWindow.addEventListener("gamepadconnected", (ev) => received.push(ev));

    const gp = createGamepadController(mockWindow, mockNav, mockDoc);
    expect(gp.simGamepad instanceof MockGamepad).toBe(true);
    expect(gp.simGamepad.buttons[0] instanceof MockGamepadButton).toBe(true);
    expect(received.length).toBe(1);
    expect(received[0] instanceof MockGamepadEvent).toBe(true);
    expect((received[0] as Event).type).toBe("gamepadconnected");
    expect((received[0] as { gamepad: Gamepad }).gamepad).toBe(gp.simGamepad);

    const gpRecord = gp.simGamepad as unknown as Record<string, unknown>;
    for (const k in gpRecord) {
      expect(() => gpRecord[k]).not.toThrow();
    }
    expect(gpRecord.pose).toBeNull();

    const btnRecord = gp.simGamepad.buttons[0] as unknown as Record<string, unknown>;
    for (const k in btnRecord) {
      expect(() => btnRecord[k]).not.toThrow();
    }
    expect(btnRecord.extraGetter).toBeNull();

    const pads = mockNav.getGamepads();
    expect(pads.length).toBe(4);
    expect(pads).toEqual([gp.simGamepad, null, null, null]);
    expect(gp.simGamepad.timestamp).toBe(4242.5);
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

  test("generalizes zero-shot to bright snow/ice tracks and learns contrastive off-road shoulders", () => {
    const w = 160;
    const h = 120;
    // Centered bright snowy road [218, 226, 236] flanked by dark slate rock/pine shoulders [55, 62, 58]
    const snowStraight = makeTestFrame(w, h, (x, y) => {
      if (y < 40) return [95, 155, 235]; // sky
      if (x >= 36 && x <= 124) return [218, 226, 236]; // snow road under wheels & lookahead
      return [55, 62, 58]; // dark pine/slate shoulder
    });

    const seedRes = analyzeRgbaFrame(snowStraight, null, w, h, createInitialRoadModel());
    expect(seedRes.updatedRoadModel.initialized).toBe(true);
    expect(seedRes.updatedRoadModel.r).toBeGreaterThan(205);
    expect(seedRes.roadConfidence).toBeGreaterThan(0.65);
    expect(seedRes.updatedRoadModel.shoulderInitialized).toBe(true);

    // Snow track curving sharply left in far lookahead band -> negative roadOffsetX & negative roadCurvature
    const snowCurveLeft = makeTestFrame(w, h, (x, y) => {
      if (y < 40) return [95, 155, 235];
      const center = y < 58 ? w * 0.28 : w * 0.48;
      if (Math.abs(x - center) < 24) return [218, 226, 236];
      return [55, 62, 58];
    });
    const leftRes = analyzeRgbaFrame(snowCurveLeft, null, w, h, seedRes.updatedRoadModel);
    expect(leftRes.roadOffsetX).toBeLessThan(-0.2);
    expect(leftRes.roadCurvature).toBeLessThan(-0.15);
  });

  test("mode-seeking road corridor avoids steering into a dead-center obstacle", () => {
    const w = 160;
    const h = 120;
    const asphaltModel = { r: 95, g: 98, b: 102, initialized: true };
    // Wide asphalt road with a bright orange/dark crate dead-center (x: 72..88) and slightly wider right lane
    const splitObstacleFrame = makeTestFrame(w, h, (x, y) => {
      if (y < 40) return [115, 180, 242];
      if (x < 24 || x > 142) return [40, 145, 45]; // outer grass
      if (y >= 46 && y <= 74 && x >= 70 && x <= 88) return [210, 65, 20]; // center obstacle
      return [95, 98, 102]; // grey asphalt on both left (24..70) and wider right (88..142)
    });

    const res = analyzeRgbaFrame(splitObstacleFrame, null, w, h, asphaltModel);
    // Mode-seeking picks the wider contiguous right corridor (> +0.25) instead of averaging left & right to 0.0
    expect(res.roadOffsetX).toBeGreaterThan(0.25);
  });

  test("driveServo supports depthSteerHint blending and resetRoadModel()", async () => {
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv();
    mockWindow.setTimeout = ((cb: TimerHandler) =>
      globalThis.setTimeout(cb, 2)) as unknown as typeof window.setTimeout;
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);

    let resetCalled = 0;
    const fakeCapture = {
      resetTracking() {},
      resetRoadModel() {
        resetCalled++;
      },
      findVideoSurface: () => ({}) as HTMLCanvasElement,
      sampleAnalysis: () => ({
        motionScore: 0.06,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0,
        roadCurvature: 0,
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
        motionScore: 0.06,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0,
        roadCurvature: 0,
        roadConfidence: 0.85,
      }),
      captureFullFrame: () => ({}) as HTMLCanvasElement,
    } as unknown as VideoCaptureEngine;

    const orch = createGameplayOrchestrator(gp, fakeCapture);
    orch.resetRoadModel();
    expect(resetCalled).toBe(1);

    const res = await orch.driveServo({
      maxDurationMs: 45,
      tickMs: 12,
      depthSteerHint: 0.6,
      unpauseSettleMs: 5,
      pauseSettleMs: 5,
      showSheetOverlay: false,
      label: "seg-depth-guided",
    });
    expect(res.ok).toBe(true);
    expect(res.meanSteerX).toBeGreaterThan(0);
  });

  test("seeds two-tone grated bridge deck and rejects cyan/blue-white striped curbs", () => {
    const w = 160;
    const h = 120;
    const bridgeFrame = makeTestFrame(w, h, (x, y) => {
      if (y < 40) return [32, 85, 138]; // twilight underwater backdrop
      // Striped cyan/blue + stark white curbs on both left and right edges
      const inLeftCurb = x >= 26 && x < 42;
      const inRightCurb = x >= 118 && x < 134;
      if (inLeftCurb || inRightCurb) {
        return Math.floor(y / 3) % 2 === 0 ? [28, 155, 232] : [236, 240, 246];
      }
      // Two-tone grated bridge slats down center (x: 42..118)
      if (x >= 42 && x < 118) {
        return x % 4 < 2 ? [76, 84, 94] : [102, 110, 120];
      }
      return [24, 52, 88]; // abyss sides
    });

    let model = createInitialRoadModel();
    const res1 = analyzeRgbaFrame(bridgeFrame, null, w, h, model);
    model = res1.updatedRoadModel;
    expect(model.initialized).toBe(true);
    // Road model must lock onto slate bridge deck (not saturated cyan curb paint)
    expect(model.b - model.r).toBeLessThan(28);
    expect(res1.roadConfidence).toBeGreaterThan(0.45);
    expect(Math.abs(res1.roadOffsetX)).toBeLessThan(0.18);
  });

  test("rejects underwater vertical stone colonnade pillars without mistaking them for open sky", () => {
    const w = 160;
    const h = 120;
    const wetStoneModel = { r: 102, g: 112, b: 128, initialized: true };

    // Wet blue-tinted stone pillar sits dead-center from y=14..110 while right corridor stays open
    const underwaterPillarFrame = makeTestFrame(w, h, (x, y) => {
      if (x >= 62 && x <= 96 && y >= 12) {
        return [88, 112, 144]; // vertical stone column (b - r = 56, lum = 115)
      }
      if (y < 45) return [28, 86, 152]; // open underwater ceiling/water
      if (x >= 34 && x <= 142) return [102, 112, 128]; // wet stone road floor
      return [24, 48, 72];
    });

    const res = analyzeRgbaFrame(
      underwaterPillarFrame,
      null,
      w,
      h,
      wetStoneModel,
    );
    // Open right corridor (96..142) beats dead-center stone pillar
    expect(res.roadOffsetX).toBeGreaterThan(0.28);
  });

  test("tracks southbound minimap odometry curving East as kart-left while ignoring static finish icon", () => {
    const tracker = new MinimapTracker();
    const mmW = 64;
    const mmH = 64;

    const drawMinimapFrame = (dotX: number, dotY: number) =>
      makeTestFrame(mmW, mmH, (x, y) => {
        // Static red finish-line tick at (46, 18) on far branch
        if (Math.hypot(x - 46, y - 18) <= 1.6) return [230, 35, 35];
        // Moving red player marker
        if (Math.hypot(x - dotX, y - dotY) <= 1.8) return [235, 32, 32];
        // Vertical track ribbon down x=22 (y=10..34), then bending East (+x, y=34..40, x=22..44)
        const onVertical = Math.abs(x - 22) <= 1.5 && y >= 10 && y <= 36;
        const onEastBend = Math.abs(y - 36) <= 1.5 && x >= 22 && x <= 44;
        const onFarBranch = Math.abs(y - 18) <= 1.5 && x >= 42 && x <= 50;
        if (onVertical || onEastBend || onFarBranch) return [215, 218, 222];
        return [20, 26, 36];
      });

    let last = analyzeMinimapRgba(drawMinimapFrame(22, 16), mmW, mmH, tracker);
    for (let step = 1; step <= 8; step++) {
      last = analyzeMinimapRgba(drawMinimapFrame(22, 16 + step * 1.5), mmW, mmH, tracker);
    }
    expect(last.visible).toBe(true);
    expect(last.onRibbon).toBe(true);
    expect(last.headingValid).toBe(true);
    // Southbound (+y) in screen coords -> ~ +90 deg
    expect(last.headingDeg ?? 0).toBeGreaterThan(75);
    expect(last.headingDeg ?? 0).toBeLessThan(105);
    // Eastward bend (+x) when facing South (+y) is KART LEFT -> turnAhead < -0.2
    expect(last.turnAhead).toBeLessThan(-0.2);
    expect(last.distance).toBeGreaterThan(6);
  });

  test("fuses 3D depth disparity corridor and executes in-loop autoUnwedge recovery", async () => {
    // 1. Verify rgbaToNormalizedChwTensor & analyzeDisparityMap
    const rgba = makeTestFrame(280, 210, () => [128, 128, 128]);
    const chw = rgbaToNormalizedChwTensor(rgba, 280, 210);
    expect(chw.length).toBe(3 * 210 * 280);

    const dw = 28;
    const dh = 21;
    const disp = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        // Sky far (0.1), near ground close (4.5), wall blocking left & center sectors, open right sectors
        if (y >= dh * 0.7) disp[y * dw + x] = 4.5;
        else if (y >= dh * 0.25 && y <= dh * 0.5 && x < dw * 0.58) disp[y * dw + x] = 4.2;
        else disp[y * dw + x] = 0.2;
      }
    }
    const parsedDepth = analyzeDisparityMap(disp, dw, dh);
    expect(parsedDepth.wallOrObstacleAhead).toBe(true);
    expect(parsedDepth.corridorOffsetX).toBeGreaterThan(0.3);

    // 2. Verify controller autoUnwedge inside driveServo (recovering from low-motion ticks)
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv();
    mockWindow.setTimeout = ((cb: TimerHandler) =>
      globalThis.setTimeout(cb, 2)) as unknown as typeof window.setTimeout;
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);

    let modelResetCount = 0;
    const driveStartMock = performance.now();
    const fakeCapture = {
      resetTracking() {},
      resetRoadModel() {
        modelResetCount++;
      },
      findVideoSurface: () => ({}) as HTMLCanvasElement,
      sampleAnalysis: () => {
        const elapsedApprox = performance.now() - driveStartMock;
        // Once past the 350ms settle window and before autoUnwedge fires resetRoadModel(), stay wedged
        const wedged = modelResetCount === 0 && elapsedApprox > 360;
        return {
          motionScore: wedged ? 0.001 : 0.06,
          bannerDelta: 0,
          redAlertRatio: 0,
          roadOffsetX: 0,
          roadCurvature: 0,
          roadConfidence: wedged ? 0.2 : 0.88,
          updatedRoadModel: createInitialRoadModel(),
          raceFinishedCandidate: false,
        };
      },
      captureTile: (_s: unknown, tMs: number, axes: number[], buttons: number[], a: { roadOffsetX: number; roadConfidence: number; motionScore: number }) => ({
        tMs,
        width: 320,
        height: 240,
        canvas: {} as HTMLCanvasElement,
        axes,
        buttons,
        motionScore: a.motionScore,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: a.roadOffsetX,
        roadCurvature: 0,
        roadConfidence: a.roadConfidence,
      }),
      captureFullFrame: () => ({}) as HTMLCanvasElement,
    } as unknown as VideoCaptureEngine;

    const fakeDepth: DepthEngineLike = {
      async init() {
        return this.getStatus();
      },
      getStatus() {
        return {
          ready: true,
          mode: "worker",
          inputSize: [280, 210],
          inferencesCompleted: 1,
          lastInferMs: 42,
          lastResult: {
            ...parsedDepth,
            inferMs: 42,
            timestamp: performance.now(),
          },
        };
      },
      submitFrameNonBlocking() {
        return {
          ...parsedDepth,
          inferMs: 42,
          timestamp: performance.now(),
        };
      },
      async inferOnce() {
        return this.submitFrameNonBlocking({} as HTMLCanvasElement);
      },
    };

    const orch = createGameplayOrchestrator(gp, fakeCapture, fakeDepth);
    const res = await orch.driveServo({
      maxDurationMs: 650,
      tickMs: 12,
      stuckDurationMs: 60,
      unwedgeReverseMs: 12,
      unwedgeForwardMs: 12,
      unpauseSettleMs: 5,
      pauseSettleMs: 5,
      showSheetOverlay: false,
      label: "seg-unwedge",
    });

    expect(res.ok).toBe(true);
    expect(res.unwedgeCount).toBe(1);
    expect(res.stuckDetected).toBe(false);
    expect(res.stopReason).toBe("horizon_complete");
    expect(res.depthFramesUsed).toBeGreaterThanOrEqual(1);
    expect(modelResetCount).toBeGreaterThanOrEqual(1);
  });

  test("detectRaceFinished halts driveServo cleanly and skips BTN.START pause", async () => {
    const w = 160;
    const h = 120;
    // Active race frame WITH speedometer arc + minimap
    const activeRace = makeTestFrame(w, h, (x, y) => {
      if (x >= w * 0.84 && y >= h * 0.78) return [240, 245, 255]; // speedometer arc
      return [95, 102, 110];
    });
    expect(detectRaceFinished(activeRace, w, h, true)).toBe(false);
    expect(detectRaceFinished(activeRace, w, h, false)).toBe(false);

    // Post-race centered scoreboard modal (minimap gone, speedo gone, structured table inside blue box)
    const resultsModal = makeTestFrame(w, h, (x, y) => {
      const inBox = x >= w * 0.2 && x <= w * 0.8 && y >= h * 0.16 && y <= h * 0.82;
      if (inBox) {
        // Horizontal scoreboard text rows at y = 32, 46, 60, 74
        if (y % 14 >= 4 && y % 14 <= 8 && x >= w * 0.28 && x <= w * 0.72 && x % 4 !== 0) {
          return [242, 245, 248];
        }
        return [32, 62, 112]; // STK translucent navy scoreboard panel
      }
      return [145, 165, 185]; // blurred bright outer background scene
    });
    expect(detectRaceFinished(resultsModal, w, h, true)).toBe(false);
    expect(detectRaceFinished(resultsModal, w, h, false)).toBe(true);

    // Controller stops with stopReason === "race_finished" & skips BTN.START
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv();
    const pressedLog: number[][] = [];
    mockWindow.setTimeout = ((cb: TimerHandler) => {
      const pad = mockNav.getGamepads()[0];
      if (pad) {
        pressedLog.push(pad.buttons.map((b) => (b.pressed ? 1 : 0)));
      }
      return globalThis.setTimeout(cb, 2);
    }) as unknown as typeof window.setTimeout;
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);

    let tick = 0;
    const fakeCapture = {
      resetTracking() {},
      findVideoSurface: () => ({}) as HTMLCanvasElement,
      sampleAnalysis: () => {
        tick++;
        const postFinish = tick >= 25;
        return {
          motionScore: postFinish ? 0.01 : 0.06,
          bannerDelta: 0,
          redAlertRatio: 0,
          roadOffsetX: 0,
          roadCurvature: 0,
          roadConfidence: 0.8,
          updatedRoadModel: createInitialRoadModel(),
          raceFinishedCandidate: postFinish,
        };
      },
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
        roadConfidence: 0.8,
      }),
      captureFullFrame: () => ({}) as HTMLCanvasElement,
    } as unknown as VideoCaptureEngine;

    const origNow = performance.now.bind(performance);
    let simMs = 0;
    performance.now = () => {
      simMs += 110;
      return simMs;
    };
    try {
      const orch = createGameplayOrchestrator(gp, fakeCapture);
      const res = await orch.driveServo({
        maxDurationMs: 7000,
        tickMs: 5,
        unpauseSettleMs: 5,
        pauseSettleMs: 5,
        showSheetOverlay: false,
        stopOnRaceFinish: true,
        label: "seg-finish",
      });
      expect(res.raceFinished).toBe(true);
      expect(res.stopReason).toBe("race_finished");
      // Ensure BTN.START (9) was NEVER pressed after detecting race finish!
      const startPressed = pressedLog.some((btns) => btns[BTN.START] === 1);
      expect(startPressed).toBe(false);
    } finally {
      performance.now = origNow;
    }
  });

  test("exercises verbatim SKILL.md v5 snippets", async () => {
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv();
    mockWindow.setTimeout = ((cb: TimerHandler) =>
      globalThis.setTimeout(cb, 2)) as unknown as typeof window.setTimeout;
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);
    const fakeCapture = {
      resetTracking() {},
      resetRoadModel() {},
      findVideoSurface: () => ({}) as HTMLCanvasElement,
      getSurfaceDimensions: () => ({ w: 1024, h: 768 }),
      sampleAnalysis: () => ({
        motionScore: 0.06,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0,
        roadCurvature: 0,
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
        motionScore: 0.06,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0,
        roadConfidence: 0.85,
      }),
      captureFullFrame: () => ({}) as HTMLCanvasElement,
    } as unknown as VideoCaptureEngine;

    const orch = createGameplayOrchestrator(gp, fakeCapture);
    (globalThis as unknown as { window: Record<string, unknown> }).window = {
      ...(globalThis as unknown as { window: Record<string, unknown> }).window,
      gameplayApi: {
        version: "5.0.1",
        BTN,
        ...gp,
        ...orch,
      },
    };

    const gWin = globalThis as unknown as {
      window: {
        gameplayApi: typeof orch & typeof gp & { version: string; BTN: typeof BTN };
      };
    };

    // Snippet 1: Inject verification (SKILL.md §1)
    const verifyFn = async () => ({
      hasApi: Boolean(gWin.window.gameplayApi),
      version: gWin.window.gameplayApi?.version,
      depth: await gWin.window.gameplayApi?.initDepthEngine(),
      frame: gWin.window.gameplayApi?.inspectFrame(),
    });
    const verified = await verifyFn();
    expect(verified.hasApi).toBe(true);
    expect(verified.version).toBe("5.0.1");
    expect(verified.frame?.foundSurface).toBe(true);

    // Snippet 2 & 3: fast-forward performance.now slightly so 7000ms / 6000ms snippets finish in <20ms
    const origNow = performance.now.bind(performance);
    let simMs = 0;
    performance.now = () => {
      simMs += 1500;
      return simMs;
    };
    try {
      const resServo = await gWin.window.gameplayApi.driveServo({
        maxDurationMs: 7000,
        steerBias: 0,
        autoUnwedge: true,
        useInPageDepth: true,
        useMinimapOdometry: true,
        stopOnRaceFinish: true,
        showSheetOverlay: false,
        unpauseSettleMs: 2,
        pauseSettleMs: 2,
        tickMs: 2,
        label: "seg-corridor",
      });
      expect(resServo.ok).toBe(true);

      const resGuided = await gWin.window.gameplayApi.driveServo({
        maxDurationMs: 6000,
        depthSteerHint: 0.28,
        showSheetOverlay: false,
        unpauseSettleMs: 2,
        pauseSettleMs: 2,
        tickMs: 2,
        label: "seg-depth-guided",
      });
      expect(resGuided.ok).toBe(true);
    } finally {
      performance.now = origNow;
    }

    // Snippet 4: runChunk hairpin drift
    const chunkRes = await gWin.window.gameplayApi.runChunk(
      async ({ api }) => {
        await api.rampStick(0, -0.7, 0, 10);
        api.setButton(api.BTN.RB, 1);
        await api.sleep(10);
        api.setButton(api.BTN.RB, 0);
        await api.rampStick(0, 0, 0, 10);
        await api.sleep(10);
      },
      {
        holdGasButton: gWin.window.gameplayApi.BTN.Y,
        label: "seg-sharp-left",
        showSheetOverlay: false,
        unpauseSettleMs: 2,
        pauseSettleMs: 2,
      },
    );
    expect(chunkRes.ok).toBe(true);

    // Snippet 5: Unpaused 3D dual-stick runChunk (SKILL.md §3.C, Fortnite/Xbox Cloud finding)
    let sawBtnA = false;
    let sawBtnStart = false;
    const prevSetTimeout = mockWindow.setTimeout;
    mockWindow.setTimeout = ((cb: TimerHandler) => {
      const pad = mockNav.getGamepads()[0];
      if (pad?.buttons[BTN.A]?.pressed) sawBtnA = true;
      if (pad?.buttons[BTN.START]?.pressed) sawBtnStart = true;
      return globalThis.setTimeout(cb, 2);
    }) as unknown as typeof window.setTimeout;
    try {
      const unpausedRes = await gWin.window.gameplayApi.runChunk(
        async ({ api, shouldAbort }) => {
          api.setStick(1, -0.5, 0); // calibrated camera yaw
          await api.sleep(2);
          api.setStick(1, 0, 0);
          api.setStick(0, 0, -0.85); // walk forward unless stuck against wall
          for (let i = 0; i < 6 && !shouldAbort(); i++) {
            await api.sleep(2);
          }
          api.setStick(0, 0, 0);
        },
        {
          unpause: false,
          pause: false,
          showSheetOverlay: false,
          label: "seg-3d-move",
        },
      );
      expect(unpausedRes.ok).toBe(true);
    } finally {
      mockWindow.setTimeout = prevSetTimeout;
    }
    expect(sawBtnA).toBe(false);
    expect(sawBtnStart).toBe(false);
  });

  test("neutralizes stick and gas BEFORE pressing BTN.START pause (seg-40 regression)", async () => {
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv();
    const startSnapshots: Array<{ axes0: number; gasPressed: number; time: number }> = [];
    let maxSteerSeen = 0;
    mockWindow.setTimeout = ((cb: TimerHandler) => {
      const pad = mockNav.getGamepads()[0];
      if (pad) {
        maxSteerSeen = Math.max(maxSteerSeen, pad.axes[0] ?? 0);
        if (pad.buttons[BTN.START]?.pressed) {
          startSnapshots.push({
            axes0: pad.axes[0] ?? 0,
            gasPressed: pad.buttons[BTN.Y]?.pressed ? 1 : 0,
            time: startSnapshots.length,
          });
        }
      }
      return globalThis.setTimeout(cb, 2);
    }) as unknown as typeof window.setTimeout;
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);

    const fakeCapture = {
      resetTracking() {},
      resetRoadModel() {},
      findVideoSurface: () => ({}) as HTMLCanvasElement,
      sampleAnalysis: () => ({
        motionScore: 0.06,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0.95,
        roadCurvature: 0,
        roadConfidence: 0.05,
        updatedRoadModel: createInitialRoadModel(),
        raceFinishedCandidate: false,
      }),
      captureTile: (_s: unknown, tMs: number, axes: number[], buttons: number[]) => ({
        tMs,
        width: 320,
        height: 240,
        canvas: {} as HTMLCanvasElement,
        axes,
        buttons,
        motionScore: 0.06,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0.95,
        roadCurvature: 0,
        roadConfidence: 0.05,
      }),
      captureFullFrame: () => ({}) as HTMLCanvasElement,
    } as unknown as VideoCaptureEngine;

    const origNow = performance.now.bind(performance);
    let simMs = 0;
    performance.now = () => {
      simMs += 110;
      return simMs;
    };
    try {
      const orch = createGameplayOrchestrator(gp, fakeCapture);
      const res = await orch.driveServo({
        maxDurationMs: 7000,
        tickMs: 5,
        lowConfidenceMs: 250,
        unpauseSettleMs: 5,
        pauseSettleMs: 5,
        showSheetOverlay: false,
        useInPageDepth: false,
        useMinimapOdometry: false,
        label: "seg-40-pause-neutral",
      });
      expect(res.stopReason).toBe("low_confidence");
      expect(maxSteerSeen).toBeGreaterThan(0.3);
      expect(startSnapshots.length).toBe(1);
      for (const snap of startSnapshots) {
        expect(Math.abs(snap.axes0)).toBe(0);
        expect(snap.gasPressed).toBe(0);
      }

      // Also verify runChunk resets full right steer before Pause tap
      startSnapshots.length = 0;
      maxSteerSeen = 0;
      await orch.runChunk(
        async ({ api }) => {
          api.setStick(0, 0.95, 0);
          await api.sleep(5);
        },
        {
          holdGasButton: BTN.Y,
          unpauseSettleMs: 5,
          pauseSettleMs: 5,
          showSheetOverlay: false,
          label: "chunk-pause-neutral",
        },
      );
      expect(maxSteerSeen).toBeGreaterThan(0.9);
      expect(startSnapshots.length).toBe(1);
      for (const snap of startSnapshots) {
        expect(Math.abs(snap.axes0)).toBe(0);
        expect(snap.gasPressed).toBe(0);
      }
    } finally {
      performance.now = origNow;
    }
  });

  test("MinimapTracker rejects 7px light-grey cobblestone grid while tracking outlined silver ribbon", () => {
    const mmW = 64;
    const mmH = 64;

    // 1. 7px x 7px light-grey cobblestone tiles with 1px darker mortar -> must NOT flood
    const cobbleTracker = new MinimapTracker();
    const cobbleFrame = makeTestFrame(mmW, mmH, (x, y) => {
      if (x % 8 === 0 || y % 8 === 0) return [132, 136, 142];
      return [186, 188, 192];
    });
    const cobbleRes = analyzeMinimapRgba(cobbleFrame, mmW, mmH, cobbleTracker);
    expect(cobbleRes.visible).toBe(false);
    expect(cobbleRes.ribbonPixels).toBeLessThan(10);
    expect(cobbleRes.distance).toBe(0);

    // 2. Outlined 3px silver minimap ribbon rendered over cobblestone -> must track cleanly
    const tracker = new MinimapTracker();
    const drawOverCobble = (dotX: number, dotY: number) =>
      makeTestFrame(mmW, mmH, (x, y) => {
        if (Math.hypot(x - dotX, y - dotY) <= 1.8) return [235, 32, 32];
        const onVertical = Math.abs(x - 26) <= 1 && y >= 10 && y <= 46;
        if (onVertical) return [222, 226, 232];
        const onOutline = Math.abs(x - 26) <= 2.2 && y >= 9 && y <= 47;
        if (onOutline) return [72, 78, 86];
        if (x % 8 === 0 || y % 8 === 0) return [132, 136, 142];
        return [186, 188, 192];
      });

    let last = analyzeMinimapRgba(drawOverCobble(26, 16), mmW, mmH, tracker);
    for (let step = 1; step <= 6; step++) {
      last = analyzeMinimapRgba(drawOverCobble(26, 16 + step * 2), mmW, mmH, tracker);
    }
    expect(last.visible).toBe(true);
    expect(last.onRibbon).toBe(true);
    expect(last.headingValid).toBe(true);
    expect(last.ribbonPixels).toBeLessThan(mmW * mmH * 0.35);
    expect(last.distance).toBeGreaterThan(6);
  });

  test("detectRaceFinished rejects stationary pumpkin + WRONG WAY + live race clock false positives", () => {
    const w = 160;
    const h = 120;

    // Helper: draw crisp outlined white top-right race clock digits (x: 0.81..0.96, y: 0.03..0.09)
    const isTopRightClock = (x: number, y: number): "outline" | "digit" | null => {
      if (x >= Math.floor(w * 0.81) && x <= Math.floor(w * 0.96) && y >= 4 && y <= 11) {
        const inner = x >= Math.floor(w * 0.83) && x <= Math.floor(w * 0.94) && y >= 6 && y <= 9;
        if (inner && x % 2 === 0) return "digit";
        return "outline";
      }
      return null;
    };

    // 1. Seg-19 Blackhill Mansion pumpkin collision WITHOUT top-right clock (warm orange interior + cobblestone)
    const pumpkinNoClock = makeTestFrame(w, h, (x, y) => {
      // Red WRONG WAY banner in upper center
      if (x >= w * 0.32 && x <= w * 0.68 && y >= 18 && y <= 28) {
        return x % 4 === 0 ? [245, 245, 245] : [220, 35, 35];
      }
      // Huge orange ribbed pumpkin filling center modal region (x: 0.20..0.80, y: 0.25..0.85)
      if (x >= w * 0.2 && x <= w * 0.8 && y >= h * 0.25 && y <= h * 0.85) {
        return x % 8 === 0 ? [95, 42, 12] : [205, 110, 32];
      }
      // Cobblestone road margins
      return (x + y) % 6 < 3 ? [118, 122, 130] : [168, 170, 175];
    });
    expect(detectRaceFinished(pumpkinNoClock, w, h, false)).toBe(false);

    // 2. Neutral/slate upper-only HUD banner (no lower modal rows) without clock
    const upperBannerOnly = makeTestFrame(w, h, (x, y) => {
      const inBox = x >= w * 0.2 && x <= w * 0.8 && y >= h * 0.16 && y <= h * 0.82;
      if (inBox) {
        if (y >= 26 && y <= 34 && x >= w * 0.3 && x <= w * 0.7 && x % 3 !== 0) {
          return [242, 245, 248];
        }
        return [58, 66, 78];
      }
      return [145, 165, 185];
    });
    expect(detectRaceFinished(upperBannerOnly, w, h, false)).toBe(false);

    // 3. Even a scoreboard-like modal must return false when top-right live race clock is present
    const modalWithClock = makeTestFrame(w, h, (x, y) => {
      const clk = isTopRightClock(x, y);
      if (clk === "digit") return [245, 248, 250];
      if (clk === "outline") return [18, 22, 28];
      const inBox = x >= w * 0.2 && x <= w * 0.8 && y >= h * 0.16 && y <= h * 0.82;
      if (inBox) {
        if (y % 14 >= 4 && y % 14 <= 8 && x >= w * 0.28 && x <= w * 0.72 && x % 4 !== 0) {
          return [242, 245, 248];
        }
        return [32, 62, 112];
      }
      return [145, 165, 185];
    });
    expect(detectRaceFinished(modalWithClock, w, h, false)).toBe(false);
  });

  test("triggers autoUnwedge when pinned against 3D obstacle despite micro-jitter motionScore", async () => {
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv();
    mockWindow.setTimeout = ((cb: TimerHandler) =>
      globalThis.setTimeout(cb, 2)) as unknown as typeof window.setTimeout;
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);

    let modelResetCount = 0;
    const fakeCapture = {
      resetTracking() {},
      resetRoadModel() {
        modelResetCount++;
      },
      findVideoSurface: () => ({}) as HTMLCanvasElement,
      sampleAnalysis: () => {
        const pinned = modelResetCount === 0;
        return {
          // Micro-jitter motionScore ~0.022 is ABOVE default stuckThreshold (0.008)
          motionScore: pinned ? 0.022 : 0.06,
          bannerDelta: 0,
          redAlertRatio: 0,
          roadOffsetX: 0,
          roadCurvature: 0,
          roadConfidence: pinned ? 0.55 : 0.88,
          updatedRoadModel: createInitialRoadModel(),
          raceFinishedCandidate: false,
        };
      },
      captureTile: (
        _s: unknown,
        tMs: number,
        axes: number[],
        buttons: number[],
        a: { roadOffsetX: number; roadConfidence: number; motionScore: number },
      ) => ({
        tMs,
        width: 320,
        height: 240,
        canvas: {} as HTMLCanvasElement,
        axes,
        buttons,
        motionScore: a.motionScore,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: a.roadOffsetX,
        roadCurvature: 0,
        roadConfidence: a.roadConfidence,
      }),
      captureFullFrame: () => ({}) as HTMLCanvasElement,
    } as unknown as VideoCaptureEngine;

    const fakeDepth: DepthEngineLike = {
      async init() {
        return this.getStatus();
      },
      getStatus() {
        const pinned = modelResetCount === 0;
        return {
          ready: true,
          mode: "worker",
          inputSize: [280, 210],
          inferencesCompleted: 1,
          lastInferMs: 35,
          lastResult: {
            sectorClearance: [0.3, 0.25, 0.14, 0.65, 0.72],
            corridorOffsetX: 0.68,
            wallOrObstacleAhead: pinned,
            centerClearance: pinned ? 0.14 : 0.78,
            maxClearance: pinned ? 0.72 : 0.85,
            inferMs: 35,
            timestamp: performance.now(),
          },
        };
      },
      submitFrameNonBlocking() {
        return this.getStatus().lastResult;
      },
      async inferOnce() {
        return this.getStatus().lastResult;
      },
    };

    const orch = createGameplayOrchestrator(gp, fakeCapture, fakeDepth);
    const res = await orch.driveServo({
      maxDurationMs: 650,
      tickMs: 12,
      stuckDurationMs: 60,
      unwedgeReverseMs: 12,
      unwedgeForwardMs: 12,
      unpauseSettleMs: 5,
      pauseSettleMs: 5,
      showSheetOverlay: false,
      label: "seg-pinned-3d",
    });

    expect(res.ok).toBe(true);
    expect(res.unwedgeCount).toBe(1);
    expect(res.stuckDetected).toBe(false);
    expect(res.stopReason).toBe("horizon_complete");
  });

  test("coverPeekBurst, sprintMove, and getRecentHistory track 3D combat/movement safely", async () => {
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv("complete");
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);
    const canvas = {} as HTMLCanvasElement;
    const fakeCapture = {
      resetTracking() {},
      findVideoSurface: () => canvas,
      getSurfaceDimensions: () => ({ w: 64, h: 48 }),
      sampleAnalysis: () => ({
        motionScore: 0.05,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0,
        roadConfidence: 0.5,
      }),
      captureTile: (
        _s: HTMLCanvasElement,
        tMs: number,
        axes: number[],
        buttons: number[],
        a: {
          motionScore: number;
          bannerDelta: number;
          redAlertRatio: number;
          roadOffsetX: number;
          roadConfidence: number;
        },
      ) => ({
        tMs,
        width: 64,
        height: 48,
        canvas,
        axes,
        buttons,
        ...a,
      }),
      captureFullFrame: () => canvas,
    } as unknown as VideoCaptureEngine;

    const orch = createGameplayOrchestrator(gp, fakeCapture);
    const burstRes = await orch.coverPeekBurst({
      aimSettleMs: 10,
      bursts: 2,
      burstMs: 10,
      gapMs: 10,
      showSheetOverlay: false,
      label: "test-peek",
    });
    expect(burstRes.ok).toBe(true);
    expect(burstRes.finalState.buttons[BTN.LT]).toBe(0);
    expect(burstRes.finalState.buttons[BTN.RT]).toBe(0);

    const moveRes = await orch.sprintMove({
      yawX: 0.4,
      yawMs: 10,
      durationMs: 30,
      endCover: true,
      showSheetOverlay: false,
      label: "test-sprint",
    });
    expect(moveRes.ok).toBe(true);
    expect(moveRes.finalState.buttons[BTN.A]).toBe(0);
    expect(moveRes.finalState.buttons[BTN.RB]).toBe(0);

    const history = orch.getRecentHistory();
    expect(history.length).toBe(2);
    expect(history[0]?.label).toBe("test-peek");
    expect(history[1]?.label).toBe("test-sprint");
  });

  test("analyzeGtavRadarRgba detects green health, low-health alert, and directional enemy blips", () => {
    const cw = 128;
    const ch = 96;
    const rgba = new Uint8ClampedArray(cw * ch * 4);
    // Fill grey radar interior
    for (let y = 18; y < 80; y++) {
      for (let x = 10; x < 98; x++) {
        const idx = (y * cw + x) * 4;
        rgba[idx] = 70;
        rgba[idx + 1] = 75;
        rgba[idx + 2] = 80;
        rgba[idx + 3] = 255;
      }
    }
    // Fill green health bar at [10..53, 83..89]
    for (let y = 83; y < 89; y++) {
      for (let x = 10; x < 53; x++) {
        const idx = (y * cw + x) * 4;
        rgba[idx] = 60;
        rgba[idx + 1] = 175;
        rgba[idx + 2] = 70;
        rgba[idx + 3] = 255;
      }
    }
    // Place red enemy blip ahead of player (px ~ 55, py ~ 62)
    for (let y = 38; y < 42; y++) {
      for (let x = 53; x < 57; x++) {
        const idx = (y * cw + x) * 4;
        rgba[idx] = 220;
        rgba[idx + 1] = 30;
        rgba[idx + 2] = 30;
        rgba[idx + 3] = 255;
      }
    }
    const healthy = analyzeGtavRadarRgba(rgba, cw, ch);
    expect(healthy.radarVisible).toBe(true);
    expect(healthy.healthPct).toBeGreaterThan(0.8);
    expect(healthy.lowHealth).toBe(false);
    expect(healthy.enemiesAhead).toBeGreaterThan(0);
    expect(healthy.enemyAngleDeg).not.toBeNull();
    expect(Math.abs(healthy.enemyAngleDeg!)).toBeLessThan(20);

    // Replace health bar with red low-health bar
    for (let y = 83; y < 89; y++) {
      for (let x = 10; x < 53; x++) {
        const idx = (y * cw + x) * 4;
        rgba[idx] = 210;
        rgba[idx + 1] = 35;
        rgba[idx + 2] = 35;
        rgba[idx + 3] = 255;
      }
    }
    const low = analyzeGtavRadarRgba(rgba, cw, ch);
    expect(low.lowHealth).toBe(true);
    expect(low.healthPct).toBeLessThan(0.1);

    // Cutscene / HUD-hidden frame (grey background, no green/red health bar) must not false-trigger lowHealth
    for (let y = 83; y < 89; y++) {
      for (let x = 10; x < 53; x++) {
        const idx = (y * cw + x) * 4;
        rgba[idx] = 70;
        rgba[idx + 1] = 75;
        rgba[idx + 2] = 80;
        rgba[idx + 3] = 255;
      }
    }
    const cutscene = analyzeGtavRadarRgba(rgba, cw, ch);
    expect(cutscene.lowHealth).toBe(false);
  });

  test("autoCombatSweep pans toward radar flankers and gtavDrive defaults gasButton to RT", async () => {
    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv("complete");
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);
    const canvas = {} as HTMLCanvasElement;
    const seenButtons: Array<{ y: number; rt: number }> = [];
    const seenStickX: number[] = [];
    const origSetButton = gp.setButton;
    gp.setButton = (btn: number, val: number) => {
      origSetButton(btn, val);
      const st = gp.getState();
      seenButtons.push({ y: st.buttons[BTN.Y] ?? 0, rt: st.buttons[BTN.RT] ?? 0 });
    };
    const origSetStick = gp.setStick;
    gp.setStick = (idx: number, x: number, y: number) => {
      origSetStick(idx, x, y);
      if (idx === 1 && x !== 0) seenStickX.push(x);
    };

    const fakeCapture = {
      resetTracking() {},
      findVideoSurface: () => canvas,
      getSurfaceDimensions: () => ({ w: 64, h: 48 }),
      sampleAnalysis: () => ({
        motionScore: 0.08,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0,
        roadConfidence: 0.6,
      }),
      readGtavRadar: () => ({
        radarVisible: true,
        healthPct: 0.85,
        lowHealth: false,
        enemyPixels: 10,
        enemiesAhead: 0,
        enemiesLeft: 8,
        enemiesRight: 2,
        enemiesBehind: 0,
        closestEnemyDist: 0.12,
        enemyAngleDeg: -65,
      }),
      captureTile: (
        _s: HTMLCanvasElement,
        tMs: number,
        axes: number[],
        buttons: number[],
        a: {
          motionScore: number;
          bannerDelta: number;
          redAlertRatio: number;
          roadOffsetX: number;
          roadConfidence: number;
        },
      ) => ({
        tMs,
        width: 64,
        height: 48,
        canvas,
        axes,
        buttons,
        ...a,
      }),
      captureFullFrame: () => canvas,
    } as unknown as VideoCaptureEngine;

    const orch = createGameplayOrchestrator(gp, fakeCapture);
    const sweepRes = await orch.autoCombatSweep({
      maxCycles: 1,
      panMs: 10,
      aimSettleMs: 10,
      burstMs: 10,
      duckMs: 0,
      showSheetOverlay: false,
    });
    expect(sweepRes.ok).toBe(true);
    expect(seenStickX.some((x) => x < 0)).toBe(true);

    seenButtons.length = 0;
    const driveRes = await orch.gtavDrive({
      maxDurationMs: 60,
      tickMs: 12,
      showSheetOverlay: false,
    });
    expect(driveRes.ok).toBe(true);
    expect(seenButtons.some((b) => b.rt > 0)).toBe(true);
    expect(seenButtons.every((b) => b.y === 0)).toBe(true);

    // Verify sprintMove triggers L3+R3 when special:true and cleans up
    let sawL3R3 = false;
    const origSetBtn2 = gp.setButton;
    gp.setButton = (btn: number, val: number) => {
      origSetBtn2(btn, val);
      const st = gp.getState();
      if ((st.buttons[BTN.L3] ?? 0) > 0 && (st.buttons[BTN.R3] ?? 0) > 0) {
        sawL3R3 = true;
      }
    };
    const rageSprint = await orch.sprintMove({
      special: true,
      durationMs: 40,
      endCover: true,
      showSheetOverlay: false,
    });
    expect(rageSprint.ok).toBe(true);
    expect(sawL3R3).toBe(true);
  });

  test("analyzeGtavRadarRgba detects yellow objective blip angle/distance and navigateToObjective servos to it", async () => {
    const cw = 128;
    const ch = 96;
    const rgba = new Uint8ClampedArray(cw * ch * 4);
    for (let y = 18; y < 80; y++) {
      for (let x = 10; x < 98; x++) {
        const idx = (y * cw + x) * 4;
        rgba[idx] = 70;
        rgba[idx + 1] = 75;
        rgba[idx + 2] = 80;
        rgba[idx + 3] = 255;
      }
    }
    // Place yellow objective blip to the right of player (px ~ 54.8, py ~ 62.4)
    for (let y = 48; y < 52; y++) {
      for (let x = 76; x < 80; x++) {
        const idx = (y * cw + x) * 4;
        rgba[idx] = 235;
        rgba[idx + 1] = 195;
        rgba[idx + 2] = 35;
        rgba[idx + 3] = 255;
      }
    }
    const objReading = analyzeGtavRadarRgba(rgba, cw, ch);
    expect(objReading.objectiveVisible).toBe(true);
    expect(objReading.objectiveColor).toBe("yellow");
    expect(objReading.objectiveAngleDeg).toBeGreaterThan(30);
    expect(objReading.objectiveDist).toBeGreaterThan(0.15);
    expect(objReading.gpsSteerBias).toBeGreaterThan(0.3);

    const { mockWindow, mockNav, mockDoc } = createMockBrowserEnv("complete");
    const gp = createGamepadController(mockWindow, mockNav, mockDoc);
    const canvas = {} as HTMLCanvasElement;
    const yawValues: number[] = [];
    const origSetStick = gp.setStick;
    gp.setStick = (idx: number, x: number, y: number) => {
      origSetStick(idx, x, y);
      if (idx === 1 && x !== 0) yawValues.push(x);
    };

    let radarCall = 0;
    const fakeCapture = {
      resetTracking() {},
      findVideoSurface: () => canvas,
      getSurfaceDimensions: () => ({ w: 64, h: 48 }),
      sampleAnalysis: () => ({
        motionScore: 0.06,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0,
        roadCurvature: 0,
        roadConfidence: 0.8,
      }),
      readGtavRadar: () => {
        radarCall++;
        return {
          radarVisible: true,
          healthPct: 0.9,
          lowHealth: false,
          enemyPixels: 0,
          enemiesAhead: 0,
          enemiesLeft: 0,
          enemiesRight: 0,
          enemiesBehind: 0,
          closestEnemyDist: null,
          enemyAngleDeg: null,
          objectiveVisible: true,
          objectiveColor: "yellow" as const,
          objectiveAngleDeg: radarCall < 3 ? 55 : 0,
          objectiveDist: radarCall < 3 ? 0.28 : 0.06,
          objectivePixels: 16,
          gpsSteerBias: radarCall < 3 ? 0.6 : 0,
        };
      },
      captureTile: (_surface: any, tMs: number, axes: number[], buttons: number[], analysis: any) => ({
        tMs,
        width: 64,
        height: 48,
        canvas: {} as any,
        axes: [...axes],
        buttons: [...buttons],
        motionScore: analysis.motionScore,
        bannerDelta: analysis.bannerDelta,
        redAlertRatio: analysis.redAlertRatio,
        roadOffsetX: analysis.roadOffsetX,
        roadConfidence: analysis.roadConfidence,
      }),
    } as any;

    const orch = createGameplayOrchestrator(gp, fakeCapture);
    const navRes = await orch.navigateToObjective({
      maxDurationMs: 400,
      tickMs: 15,
      stopDist: 0.1,
      showSheetOverlay: false,
    });
    expect(navRes.ok).toBe(true);
    expect(navRes.stopReason).toBe("reached_objective");
    expect(yawValues.some((x) => x > 0.3)).toBe(true);

    // Also verify stopOnEnemy aborts cleanly
    const enemyCapture = {
      ...fakeCapture,
      readGtavRadar: () => ({
        ...fakeCapture.readGtavRadar(),
        enemyPixels: 12,
        enemiesAhead: 12,
        objectiveDist: 0.35,
      }),
    };
    const orchEnemy = createGameplayOrchestrator(gp, enemyCapture);
    const enemyStop = await orchEnemy.navigateToObjective({
      maxDurationMs: 400,
      tickMs: 15,
      stopOnEnemy: true,
      showSheetOverlay: false,
    });
    expect(enemyStop.stopReason).toBe("enemy_detected");

    // Verify switchCharacter holds DPAD_DOWN, deflects stick 1, and releases DPAD_DOWN before stick 1
    const events: string[] = [];
    const origBtn3 = gp.setButton;
    gp.setButton = (btn: number, val: number) => {
      origBtn3(btn, val);
      if (btn === BTN.DPAD_DOWN) events.push(`dpad:${val}`);
    };
    const origStk3 = gp.setStick;
    gp.setStick = (idx: number, x: number, y: number) => {
      origStk3(idx, x, y);
      if (idx === 1) events.push(`stk1:${x},${y}`);
    };
    const swRes = await orch.switchCharacter({
      dirX: 1,
      dirY: 0,
      holdMs: 30,
      settleMs: 10,
      showSheetOverlay: false,
    });
    expect(swRes.ok).toBe(true);
    expect(events.indexOf("dpad:1")).toBeLessThan(events.indexOf("stk1:1,0"));
    expect(events.indexOf("dpad:0")).toBeLessThan(events.indexOf("stk1:0,0"));

    // Verify waitForRadar polls until radarVisible matches
    let waitCalls = 0;
    const waitOrch = createGameplayOrchestrator(gp, {
      ...fakeCapture,
      readGtavRadar: () => {
        waitCalls++;
        return {
          ...fakeCapture.readGtavRadar(),
          radarVisible: waitCalls >= 3,
        };
      },
    });
    const waitRes = await waitOrch.waitForRadar({
      visible: true,
      timeoutMs: 500,
      pollMs: 10,
    });
    expect(waitRes?.radarVisible).toBe(true);
    expect(waitCalls).toBeGreaterThanOrEqual(3);

    // Verify retryMission taps BTN.A and waits for radarVisible
    let retryCalls = 0;
    const retryEvents: number[] = [];
    const origTapBtn = gp.tapButton;
    gp.tapButton = async (btn: number, holdMs?: number, settle?: number) => {
      retryEvents.push(btn);
      return origTapBtn(btn, holdMs, settle);
    };
    const retryOrch = createGameplayOrchestrator(gp, {
      ...fakeCapture,
      readGtavRadar: () => {
        retryCalls++;
        return {
          ...fakeCapture.readGtavRadar(),
          radarVisible: retryCalls >= 2,
        };
      },
    });
    const retryRes = await retryOrch.retryMission({
      tapMs: 15,
      radarTimeoutMs: 1000,
      pollMs: 10,
      settleMs: 10,
    });
    expect(retryRes.ok).toBe(true);
    expect(retryRes.radarVisible).toBe(true);
    expect(retryEvents).toContain(BTN.A);

    // Verify analyzeGtavReticleRgba distinguishes enemy (red), friendly (green), and neutral (white)
    const retBuf = new Uint8ClampedArray(32 * 32 * 4);
    const fillCenter = (r: number, g: number, b: number) => {
      retBuf.fill(0);
      for (let y = 13; y < 18; y++) {
        for (let x = 13; x < 18; x++) {
          const i = (y * 32 + x) * 4;
          retBuf[i] = r;
          retBuf[i + 1] = g;
          retBuf[i + 2] = b;
          retBuf[i + 3] = 255;
        }
      }
    };
    fillCenter(230, 35, 35);
    expect(analyzeGtavReticleRgba(retBuf, 32, 32).state).toBe("enemy");
    fillCenter(45, 220, 60);
    expect(analyzeGtavReticleRgba(retBuf, 32, 32).state).toBe("friendly");
    fillCenter(245, 245, 245);
    expect(analyzeGtavReticleRgba(retBuf, 32, 32).state).toBe("neutral");

    // Verify autoCombatSweep skips RT when reticle stays friendly
    const friendlyFires: number[] = [];
    const origSetBtnF = gp.setButton;
    gp.setButton = (btn: number, val: number) => {
      origSetBtnF(btn, val);
      if (btn === BTN.RT && val > 0) friendlyFires.push(val);
    };
    const friendlyOrch = createGameplayOrchestrator(gp, {
      ...fakeCapture,
      readGtavReticle: () => ({
        state: "friendly" as const,
        redPixels: 0,
        greenPixels: 12,
        whitePixels: 0,
      }),
    });
    await friendlyOrch.autoCombatSweep({
      maxCycles: 1,
      autoPan: false,
      verifyReticle: true,
      reticleScanMs: 50,
      aimSettleMs: 10,
      burstMs: 20,
      showSheetOverlay: false,
    });
    expect(friendlyFires.length).toBe(0);

    // Verify requireEnemyReticle skips RT when reticle stays neutral
    const neutralOrch = createGameplayOrchestrator(gp, {
      ...fakeCapture,
      readGtavReticle: () => ({
        state: "neutral" as const,
        redPixels: 0,
        greenPixels: 0,
        whitePixels: 10,
      }),
    });
    await neutralOrch.autoCombatSweep({
      maxCycles: 1,
      autoPan: false,
      verifyReticle: true,
      requireEnemyReticle: true,
      reticleScanMs: 40,
      aimSettleMs: 10,
      burstMs: 20,
      showSheetOverlay: false,
    });
    expect(friendlyFires.length).toBe(0);
  });
});
