import { BTN, clamp, type GamepadController } from "./gamepad";
import type {
  ChunkOptions,
  ChunkResult,
  DriveServoOptions,
  FrameSample,
} from "./types";
import {
  buildContactSheetCanvas,
  DEFAULT_STK_CROPS,
  hideSheetOverlay,
  showSheetOverlay,
  VideoCaptureEngine,
} from "./vision";

export interface PidState {
  prevError: number;
  prevSteer: number;
}

/**
 * Pure PD steering step with slew-rate limiting so fast control loops never
 * snap the analog stick abruptly from edge to edge.
 */
export function computePidSteer(
  targetOffsetX: number,
  state: PidState,
  dtSec: number,
  kp = 0.95,
  kd = 0.22,
  maxSteer = 0.85,
  maxRatePerSec = 4.5,
): { steer: number; nextState: PidState } {
  const err = clamp(targetOffsetX, -1, 1);
  const safeDt = Math.max(0.005, dtSec);
  const deriv = (err - state.prevError) / safeDt;
  const raw = kp * err + kd * deriv;
  const desired = clamp(raw, -maxSteer, maxSteer);

  const maxStep = maxRatePerSec * safeDt;
  const delta = clamp(desired - state.prevSteer, -maxStep, maxStep);
  const steer = clamp(state.prevSteer + delta, -maxSteer, maxSteer);

  return {
    steer,
    nextState: { prevError: err, prevSteer: steer },
  };
}

export interface GameplayOrchestrator {
  runChunk(
    actions: (ctx: {
      api: GamepadController;
      shouldAbort: () => boolean;
      captureNow: () => void;
    }) => Promise<void> | void,
    options?: ChunkOptions,
  ): Promise<ChunkResult>;
  driveServo(options?: DriveServoOptions): Promise<ChunkResult>;
  smartRescue(options?: ChunkOptions): Promise<ChunkResult>;
  hideOverlay(): void;
  inspectFrame(): {
    foundSurface: boolean;
    width: number;
    height: number;
    motionScore: number;
    bannerDelta: number;
    redAlertRatio: number;
    roadOffsetX: number;
    roadConfidence: number;
  };
}

export function createGameplayOrchestrator(
  gamepad: GamepadController,
  captureEngine?: VideoCaptureEngine,
): GameplayOrchestrator {
  let engine: VideoCaptureEngine | null = captureEngine ?? null;

  function getEngine(): VideoCaptureEngine {
    if (!engine) engine = new VideoCaptureEngine();
    return engine;
  }

  function summarizeSamples(
    samples: FrameSample[],
    label: string,
    stopReason: string,
    durationMs: number,
    stuckDetected: boolean,
    ok: boolean,
    error?: string,
    includeSheetDataUrl = false,
    surface: HTMLCanvasElement | HTMLVideoElement | null = null,
    options: ChunkOptions = {},
  ): ChunkResult {
    const count = samples.length;
    let sumMotion = 0;
    let minMotion = count > 1 ? Infinity : 0;
    let maxBannerDelta = 0;
    let maxRedAlertRatio = 0;
    let sumConf = 0;
    let sumSteer = 0;

    for (let i = 0; i < count; i++) {
      const s = samples[i];
      if (i > 0) {
        sumMotion += s.motionScore;
        if (s.motionScore < minMotion) minMotion = s.motionScore;
        if (s.bannerDelta > maxBannerDelta) maxBannerDelta = s.bannerDelta;
      }
      if (s.redAlertRatio > maxRedAlertRatio) maxRedAlertRatio = s.redAlertRatio;
      sumConf += s.roadConfidence;
      sumSteer += s.axes[0] ?? 0;
    }

    const avgMotion = count > 1 ? sumMotion / (count - 1) : 0;
    const avgRoadConfidence = count > 0 ? sumConf / count : 0;
    const meanSteerX = count > 0 ? sumSteer / count : 0;

    let sheetDataUrl: string | undefined;
    if (count > 0 && (options.showSheetOverlay ?? true)) {
      const sheet = buildContactSheetCanvas(
        samples,
        surface,
        { label, stopReason, durationMs, avgMotion, avgRoadConfidence },
        options.crops ?? DEFAULT_STK_CROPS,
      );
      showSheetOverlay(sheet);
      if (includeSheetDataUrl) {
        sheetDataUrl = sheet.toDataURL("image/jpeg", 0.82);
      }
    }

    return {
      ok,
      error,
      label,
      stopReason,
      durationMs,
      framesCaptured: count,
      avgMotion,
      minMotion: Number.isFinite(minMotion) ? minMotion : 0,
      maxBannerDelta,
      maxRedAlertRatio,
      avgRoadConfidence,
      meanSteerX,
      stuckDetected,
      finalState: gamepad.getState(),
      sheetDataUrl,
    };
  }

  async function runChunk(
    actions: (ctx: {
      api: GamepadController;
      shouldAbort: () => boolean;
      captureNow: () => void;
    }) => Promise<void> | void,
    options: ChunkOptions = {},
  ): Promise<ChunkResult> {
    const {
      unpause = true,
      unpauseButton = BTN.A,
      pause = true,
      pauseButton = BTN.START,
      unpauseSettleMs = 220,
      pauseSettleMs = 150,
      sampleIntervalMs = 140,
      holdGasButton = null,
      resetOnEnd = true,
      stopOnStuck = true,
      stuckThreshold = 0.008,
      stuckDurationMs = 600,
      label = "chunk",
    } = options;

    hideSheetOverlay();
    const eng = getEngine();
    eng.resetTracking();
    if (!unpause && typeof eng.resetRoadModel === "function") {
      eng.resetRoadModel();
    }
    const surface = eng.findVideoSurface();
    const samples: FrameSample[] = [];
    let aborted = false;
    let stopReason = "completed";
    let stuckDetected = false;
    let lowMotionMs = 0;
    let lastSampleAt = 0;
    const startedAt = performance.now();

    function captureNow(): void {
      if (!surface) return;
      const now = performance.now();
      const dt = lastSampleAt > 0 ? now - lastSampleAt : 0;
      lastSampleAt = now;
      const analysis = eng.sampleAnalysis(surface);
      const state = gamepad.getState();
      const elapsed = now - startedAt;

      samples.push(
        eng.captureTile(surface, elapsed, state.axes, state.buttons, analysis),
      );

      if (stopOnStuck && samples.length >= 3 && elapsed > 350) {
        if (analysis.motionScore < stuckThreshold) {
          lowMotionMs += dt;
          if (lowMotionMs >= stuckDurationMs) {
            stuckDetected = true;
            aborted = true;
            stopReason = "stuck";
          }
        } else {
          lowMotionMs = 0;
        }
      }
    }

    let timerId: number | undefined;
    let errMsg: string | undefined;
    let ok = true;
    let prePauseSurface: HTMLCanvasElement | null = null;

    try {
      // Unpause first so STK registers a fresh rising edge on gas after closing the pause menu
      if (unpause) {
        await gamepad.tapButton(unpauseButton, 90, unpauseSettleMs);
      }
      if (holdGasButton !== null) {
        gamepad.setButton(holdGasButton, 1);
      }

      captureNow();
      timerId = window.setInterval(captureNow, sampleIntervalMs);

      await actions({
        api: gamepad,
        shouldAbort: () => aborted,
        captureNow,
      });

      captureNow();
    } catch (err) {
      ok = false;
      stopReason = "error";
      errMsg = err instanceof Error ? err.message : String(err);
    } finally {
      if (timerId !== undefined) window.clearInterval(timerId);
      // Snapshot unpaused video surface BEFORE pause overlay hides HUD/minimap
      if (surface && typeof eng.captureFullFrame === "function") {
        try {
          prePauseSurface = eng.captureFullFrame(surface);
        } catch {
          // ignore snapshot error
        }
      }
      if (pause) {
        try {
          await gamepad.tapButton(pauseButton, 90, pauseSettleMs);
        } catch {
          // ignore secondary error during pause cleanup
        }
      }
      if (resetOnEnd) {
        gamepad.resetAll();
      }
    }

    const durationMs = performance.now() - startedAt;
    return summarizeSamples(
      samples,
      label,
      stopReason,
      durationMs,
      stuckDetected,
      ok,
      errMsg,
      false,
      prePauseSurface ?? surface,
      options,
    );
  }

  async function driveServo(options: DriveServoOptions = {}): Promise<ChunkResult> {
    const {
      maxDurationMs = 3000,
      tickMs = 33,
      kp = 1.25,
      kd = 0.25,
      maxSteer = 0.95,
      gasButton = BTN.Y,
      throttleModulation = true,
      steerBias = 0,
      stopOnBannerChange = false,
      bannerDeltaThreshold = 0.28,
      stopOnLowConfidence = true,
      minConfidence = 0.25,
      lowConfidenceMs = 280,
      stopOnRedAlert = true,
      redAlertThreshold = 0.035,
      unpause = true,
      unpauseButton = BTN.A,
      pause = true,
      pauseButton = BTN.START,
      unpauseSettleMs = 220,
      pauseSettleMs = 150,
      sampleIntervalMs = 180,
      stopOnStuck = true,
      stuckThreshold = 0.008,
      stuckDurationMs = 550,
      resetOnEnd = true,
      label = "servo",
    } = options;

    hideSheetOverlay();
    const eng = getEngine();
    eng.resetTracking();
    if (!unpause && typeof eng.resetRoadModel === "function") {
      eng.resetRoadModel();
    }
    const surface = eng.findVideoSurface();
    if (!surface) {
      return {
        ok: false,
        error: "No live video or canvas surface found",
        label,
        stopReason: "no_surface",
        durationMs: 0,
        framesCaptured: 0,
        avgMotion: 0,
        minMotion: 0,
        maxBannerDelta: 0,
        maxRedAlertRatio: 0,
        avgRoadConfidence: 0,
        meanSteerX: 0,
        stuckDetected: false,
        finalState: gamepad.getState(),
      };
    }

    const samples: FrameSample[] = [];
    let pidState: PidState = { prevError: 0, prevSteer: 0 };
    let stopReason = "horizon_complete";
    let stuckDetected = false;
    let errMsg: string | undefined;
    let ok = true;
    let prePauseSurface: HTMLCanvasElement | null = null;

    const startedAt = performance.now();

    try {
      // Unpause first so STK sees a fresh gas press after leaving the pause dialog
      if (unpause) {
        await gamepad.tapButton(unpauseButton, 90, unpauseSettleMs);
      }
      gamepad.setButton(gasButton, 1);

      const driveStart = performance.now();
      let lastTick = driveStart;
      let lastTileAt = -Infinity;
      let lowMotionAcc = 0;
      let lowConfAcc = 0;
      let tickIndex = 0;

      while (true) {
        const now = performance.now();
        const elapsed = now - driveStart;
        if (elapsed >= maxDurationMs) {
          stopReason = "horizon_complete";
          break;
        }

        const dtMs = Math.max(10, now - lastTick);
        lastTick = now;

        const analysis = eng.sampleAnalysis(surface);
        const target = clamp(analysis.roadOffsetX + steerBias, -1, 1);
        const pid = computePidSteer(
          target,
          pidState,
          dtMs / 1000,
          kp,
          kd,
          maxSteer,
          5.5,
        );
        pidState = pid.nextState;
        gamepad.setStick(0, pid.steer, 0);

        // Curvature-coupled throttle modulation: ease gas duty cycle on tight turns
        // after initial acceleration settle so the kart tucks into corners instead of understeering wide.
        if (throttleModulation && elapsed > 380) {
          const absSteer = Math.abs(pid.steer);
          if (absSteer > 0.68) {
            gamepad.setButton(gasButton, tickIndex % 3 === 0 ? 1 : 0);
          } else if (absSteer > 0.44) {
            gamepad.setButton(gasButton, tickIndex % 2 === 0 ? 1 : 0);
          } else {
            gamepad.setButton(gasButton, 1);
          }
        } else {
          gamepad.setButton(gasButton, 1);
        }
        tickIndex++;

        const state = gamepad.getState();
        if (now - lastTileAt >= sampleIntervalMs) {
          lastTileAt = now;
          samples.push(
            eng.captureTile(surface, elapsed, state.axes, state.buttons, analysis),
          );
        }

        // Event checks after initial 350ms settle
        if (elapsed > 350) {
          if (stopOnStuck && analysis.motionScore < stuckThreshold) {
            lowMotionAcc += dtMs;
            if (lowMotionAcc >= stuckDurationMs) {
              stuckDetected = true;
              stopReason = "stuck";
              break;
            }
          } else {
            lowMotionAcc = 0;
          }

          if (stopOnRedAlert && analysis.redAlertRatio >= redAlertThreshold) {
            stopReason = "red_alert";
            break;
          }

          if (
            stopOnBannerChange &&
            elapsed > 500 &&
            analysis.bannerDelta >= bannerDeltaThreshold
          ) {
            stopReason = "banner_changed";
            break;
          }

          if (stopOnLowConfidence && analysis.roadConfidence < minConfidence) {
            lowConfAcc += dtMs;
            if (lowConfAcc >= lowConfidenceMs) {
              stopReason = "low_confidence";
              break;
            }
          } else {
            lowConfAcc = 0;
          }
        }

        await gamepad.sleep(tickMs);
      }

      // Always capture exact final frame before pause overlay covers screen
      const finalAnalysis = eng.sampleAnalysis(surface);
      const finalSnap = gamepad.getState();
      samples.push(
        eng.captureTile(
          surface,
          performance.now() - driveStart,
          finalSnap.axes,
          finalSnap.buttons,
          finalAnalysis,
        ),
      );
    } catch (err) {
      ok = false;
      stopReason = "error";
      errMsg = err instanceof Error ? err.message : String(err);
    } finally {
      // Snapshot unpaused video surface BEFORE pause overlay hides HUD/minimap
      if (surface && typeof eng.captureFullFrame === "function") {
        try {
          prePauseSurface = eng.captureFullFrame(surface);
        } catch {
          // ignore snapshot error
        }
      }
      if (pause) {
        try {
          await gamepad.tapButton(pauseButton, 90, pauseSettleMs);
        } catch {
          // ignore
        }
      }
      if (resetOnEnd) {
        gamepad.resetAll();
      }
    }

    const durationMs = performance.now() - startedAt;
    return summarizeSamples(
      samples,
      label,
      stopReason,
      durationMs,
      stuckDetected,
      ok,
      errMsg,
      false,
      prePauseSurface ?? surface,
      options,
    );
  }

  async function smartRescue(options: ChunkOptions = {}): Promise<ChunkResult> {
    return runChunk(
      async ({ api }) => {
        await api.tapButton(BTN.BACK, 180, 1400);
      },
      {
        ...options,
        stopOnStuck: false,
        label: options.label ?? "rescue",
      },
    );
  }

  function inspectFrame() {
    const eng = getEngine();
    const surface = eng.findVideoSurface();
    if (!surface) {
      return {
        foundSurface: false,
        width: 0,
        height: 0,
        motionScore: 0,
        bannerDelta: 0,
        redAlertRatio: 0,
        roadOffsetX: 0,
        roadConfidence: 0,
      };
    }
    const dims = eng.getSurfaceDimensions(surface);
    const analysis = eng.sampleAnalysis(surface, false);
    return {
      foundSurface: true,
      width: dims.w,
      height: dims.h,
      motionScore: analysis.motionScore,
      bannerDelta: analysis.bannerDelta,
      redAlertRatio: analysis.redAlertRatio,
      roadOffsetX: analysis.roadOffsetX,
      roadConfidence: analysis.roadConfidence,
    };
  }

  return {
    runChunk,
    driveServo,
    smartRescue,
    hideOverlay: hideSheetOverlay,
    inspectFrame,
  };
}
