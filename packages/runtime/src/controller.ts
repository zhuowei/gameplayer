import { BTN, clamp, type GamepadController } from "./gamepad";
import {
  BrowserDepthEngine,
  type DepthEngineLike,
  type DepthEngineStatus,
} from "./depth";
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
  type MinimapReading,
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
  resetRoadModel(): void;
  initDepthEngine(): Promise<DepthEngineStatus>;
  getDepthStatus(): DepthEngineStatus;
  inspectFrame(): {
    foundSurface: boolean;
    width: number;
    height: number;
    motionScore: number;
    bannerDelta: number;
    redAlertRatio: number;
    roadOffsetX: number;
    roadCurvature: number;
    roadConfidence: number;
    minimap?: MinimapReading;
    depth?: DepthEngineStatus;
  };
}

export function createGameplayOrchestrator(
  gamepad: GamepadController,
  captureEngine?: VideoCaptureEngine,
  depthEngine?: DepthEngineLike,
): GameplayOrchestrator {
  let engine: VideoCaptureEngine | null = captureEngine ?? null;
  let depth: DepthEngineLike | null = depthEngine ?? null;

  function getEngine(): VideoCaptureEngine {
    if (!engine) engine = new VideoCaptureEngine();
    return engine;
  }

  function getDepthEngine(): DepthEngineLike {
    if (!depth) depth = new BrowserDepthEngine();
    return depth;
  }

  async function initDepthEngine(): Promise<DepthEngineStatus> {
    return await getDepthEngine().init();
  }

  function getDepthStatus(): DepthEngineStatus {
    return getDepthEngine().getStatus();
  }

  function resetRoadModel(): void {
    const eng = getEngine();
    if (typeof eng.resetRoadModel === "function") {
      eng.resetRoadModel();
    }
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
    extras: {
      unwedgeCount?: number;
      raceFinished?: boolean;
      depthFramesUsed?: number;
      minimapHeadingDeg?: number | null;
      minimapTurnAhead?: number;
      minimapDistance?: number;
    } = {},
  ): ChunkResult {
    const count = samples.length;
    let sumMotion = 0;
    let minMotion = count > 1 ? Infinity : 0;
    let maxBannerDelta = 0;
    let maxRedAlertRatio = 0;
    let sumConf = 0;
    let sumSteer = 0;
    let sumCurvature = 0;

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
      sumCurvature += s.roadCurvature ?? 0;
    }

    const avgMotion = count > 1 ? sumMotion / (count - 1) : 0;
    const avgRoadConfidence = count > 0 ? sumConf / count : 0;
    const meanSteerX = count > 0 ? sumSteer / count : 0;
    const meanCurvature = count > 0 ? sumCurvature / count : 0;

    let sheetDataUrl: string | undefined;
    if (count > 0 && (options.showSheetOverlay ?? true)) {
      const sheet = buildContactSheetCanvas(
        samples,
        surface,
        {
          label,
          stopReason,
          durationMs,
          avgMotion,
          avgRoadConfidence,
          depthFramesUsed: extras.depthFramesUsed,
          unwedgeCount: extras.unwedgeCount,
          minimapTurnAhead: extras.minimapTurnAhead,
        },
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
      meanCurvature,
      stuckDetected,
      unwedgeCount: extras.unwedgeCount,
      raceFinished: extras.raceFinished,
      depthFramesUsed: extras.depthFramesUsed,
      minimapHeadingDeg: extras.minimapHeadingDeg,
      minimapTurnAhead: extras.minimapTurnAhead,
      minimapDistance: extras.minimapDistance,
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
      maxDurationMs = 7000,
      tickMs = 33,
      kp = 1.25,
      kd = 0.25,
      maxSteer = 0.95,
      gasButton = BTN.Y,
      throttleModulation = true,
      autoCornerBrake = true,
      steerBias = 0,
      depthSteerHint,
      depthHintWeight = 0.3,
      stopOnBannerChange = false,
      bannerDeltaThreshold = 0.28,
      stopOnLowConfidence = true,
      minConfidence = 0.25,
      lowConfidenceMs = 280,
      stopOnRedAlert = true,
      redAlertThreshold = 0.035,
      autoUnwedge = true,
      maxUnwedgeAttempts = 2,
      unwedgeReverseMs = 420,
      unwedgeForwardMs = 480,
      useInPageDepth = true,
      useMinimapOdometry = true,
      stopOnRaceFinish = true,
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
    const dEngine = getDepthEngine();
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
        meanCurvature: 0,
        stuckDetected: false,
        unwedgeCount: 0,
        raceFinished: false,
        depthFramesUsed: 0,
        finalState: gamepad.getState(),
      };
    }

    const samples: FrameSample[] = [];
    let pidState: PidState = { prevError: 0, prevSteer: 0 };
    let stopReason = "horizon_complete";
    let stuckDetected = false;
    let raceFinished = false;
    let unwedgeCount = 0;
    let depthFramesUsed = 0;
    let lastSeenDepthTs = -1;
    let minimapHeadingDeg: number | null = null;
    let minimapTurnAhead = 0;
    let minimapDistance = 0;
    let errMsg: string | undefined;
    let ok = true;
    let prePauseSurface: HTMLCanvasElement | null = null;

    const startedAt = performance.now();

    try {
      // If depth fell back to synchronous main_thread WASM, refresh once safely before unpausing
      if (useInPageDepth && dEngine.getStatus().mode === "main_thread") {
        const preDepth = await dEngine.inferOnce(surface);
        if (preDepth) {
          lastSeenDepthTs = preDepth.timestamp;
          depthFramesUsed++;
        }
      }

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
      let activeMotionTicks = 0;
      let finishConsecutiveTicks = 0;
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
        if (analysis.motionScore > 0.012) {
          activeMotionTicks++;
        }

        const rawDepth = useInPageDepth ? dEngine.submitFrameNonBlocking(surface) : null;
        const freshDepth =
          rawDepth && now - rawDepth.timestamp < 1800 ? rawDepth : null;
        if (freshDepth && freshDepth.timestamp !== lastSeenDepthTs) {
          lastSeenDepthTs = freshDepth.timestamp;
          depthFramesUsed++;
        }

        // Feed-forward curvature + optional 30Hz minimap odometry + non-blocking 3D depth + host hint
        let visualTarget = analysis.roadOffsetX + (analysis.roadCurvature ?? 0) * 0.18;

        const mm = analysis.minimap;
        if (useMinimapOdometry && mm && mm.visible) {
          minimapHeadingDeg = mm.headingDeg;
          minimapDistance = mm.distance;
          if (mm.headingValid) {
            minimapTurnAhead = mm.turnAhead;
            const mmWeight = analysis.roadConfidence >= 0.45 ? 0.2 : 0.4;
            visualTarget =
              (1 - mmWeight) * visualTarget +
              mmWeight * clamp(mm.turnAhead, -1, 1);
          } else {
            minimapTurnAhead = 0;
          }
        }

        if (freshDepth) {
          const dWeight =
            freshDepth.wallOrObstacleAhead || freshDepth.centerClearance < 0.48
              ? 0.55
              : 0.22;
          visualTarget =
            (1 - dWeight) * visualTarget +
            dWeight * clamp(freshDepth.corridorOffsetX, -1, 1);
        }

        if (typeof depthSteerHint === "number" && Number.isFinite(depthSteerHint)) {
          const w = clamp(depthHintWeight, 0, 1);
          visualTarget = (1 - w) * visualTarget + w * clamp(depthSteerHint, -1, 1);
        }

        const target = clamp(visualTarget + steerBias, -1, 1);
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

        // Curvature-coupled throttle + high-speed-confirmed corner braking
        if (throttleModulation && elapsed > 380) {
          const absSteer = Math.max(Math.abs(pid.steer), Math.abs(target) * 0.85);
          const absCurv = Math.abs(analysis.roadCurvature ?? 0);
          const confirmedTightCorner =
            Math.abs(analysis.roadOffsetX) > 0.48 ||
            absCurv > 0.34 ||
            (freshDepth !== null && freshDepth.centerClearance < 0.42);
          if (
            autoCornerBrake &&
            elapsed > 1100 &&
            analysis.motionScore > 0.042 &&
            absSteer > 0.84 &&
            confirmedTightCorner
          ) {
            gamepad.setButton(gasButton, 0);
            gamepad.setButton(BTN.X, tickIndex % 3 === 0 ? 1 : 0);
          } else if (absSteer > 0.68 || absCurv > 0.3) {
            gamepad.setButton(BTN.X, 0);
            gamepad.setButton(gasButton, tickIndex % 3 === 0 ? 1 : 0);
          } else if (
            absSteer > 0.44 ||
            absCurv > 0.18 ||
            (freshDepth !== null && freshDepth.centerClearance < 0.52)
          ) {
            gamepad.setButton(BTN.X, 0);
            gamepad.setButton(gasButton, tickIndex % 2 === 0 ? 1 : 0);
          } else {
            gamepad.setButton(BTN.X, 0);
            gamepad.setButton(gasButton, 1);
          }
        } else {
          gamepad.setButton(BTN.X, 0);
          gamepad.setButton(gasButton, 1);
        }
        tickIndex++;

        const state = gamepad.getState();
        if (now - lastTileAt >= sampleIntervalMs) {
          lastTileAt = now;
          samples.push(
            eng.captureTile(
              surface,
              elapsed,
              state.axes,
              state.buttons,
              analysis,
              320,
              240,
              freshDepth,
            ),
          );
        }

        // In-loop race finish detection (only after active driving + post-race scoreboard modal appears)
        if (stopOnRaceFinish && elapsed > 1200 && activeMotionTicks >= 4) {
          if (analysis.raceFinishedCandidate) {
            finishConsecutiveTicks++;
            if (finishConsecutiveTicks >= 4) {
              raceFinished = true;
              stopReason = "race_finished";
              gamepad.resetAll();
              await gamepad.sleep(200);
              break;
            }
          } else {
            finishConsecutiveTicks = 0;
          }
        }

        // Event checks after initial 350ms settle
        if (elapsed > 350) {
          if (stopOnStuck && analysis.motionScore < stuckThreshold) {
            lowMotionAcc += dtMs;
            if (lowMotionAcc >= stuckDurationMs) {
              if (autoUnwedge && unwedgeCount < maxUnwedgeAttempts) {
                unwedgeCount++;
                lowMotionAcc = 0;
                lowConfAcc = 0;

                let uwDepth = freshDepth;
                if (
                  useInPageDepth &&
                  !uwDepth &&
                  dEngine.getStatus().mode === "main_thread"
                ) {
                  uwDepth = await dEngine.inferOnce(surface);
                  if (uwDepth && uwDepth.timestamp !== lastSeenDepthTs) {
                    lastSeenDepthTs = uwDepth.timestamp;
                    depthFramesUsed++;
                  }
                }

                let escapeSign = unwedgeCount % 2 === 1 ? 1 : -1;
                if (uwDepth && Math.abs(uwDepth.corridorOffsetX) > 0.12) {
                  escapeSign = Math.sign(uwDepth.corridorOffsetX);
                } else if (
                  useMinimapOdometry &&
                  mm?.visible &&
                  mm.headingValid &&
                  Math.abs(mm.turnAhead) > 0.12
                ) {
                  escapeSign = Math.sign(mm.turnAhead);
                } else if (Math.abs(analysis.roadOffsetX) > 0.08) {
                  escapeSign = Math.sign(analysis.roadOffsetX);
                }

                // 1) Straight reverse off wall/obstacle
                gamepad.setButton(gasButton, 0);
                gamepad.setStick(0, 0, 0);
                gamepad.setButton(BTN.X, 1);
                await gamepad.sleep(unwedgeReverseMs);
                gamepad.setButton(BTN.X, 0);
                await gamepad.sleep(40);
                if (typeof eng.resetRoadModel === "function") {
                  eng.resetRoadModel();
                }

                // 2) Turn forward toward highest-clearance open corridor
                gamepad.setStick(0, 0.78 * escapeSign, 0);
                gamepad.setButton(gasButton, 1);
                await gamepad.sleep(unwedgeForwardMs);

                const uwAnalysis = eng.sampleAnalysis(surface);
                const uwState = gamepad.getState();
                lastTileAt = performance.now();
                samples.push(
                  eng.captureTile(
                    surface,
                    lastTileAt - driveStart,
                    uwState.axes,
                    uwState.buttons,
                    uwAnalysis,
                    320,
                    240,
                    uwDepth,
                  ),
                );
                pidState = { prevError: 0, prevSteer: 0.5 * escapeSign };
                lastTick = performance.now();
                lowMotionAcc = 0;
                lowConfAcc = 0;
                continue;
              }
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
            const depthConfirmsTrack =
              freshDepth !== null && freshDepth.maxClearance >= 0.48;
            const minimapConfirmsTrack =
              useMinimapOdometry &&
              Boolean(mm?.visible && mm.onRibbon && mm.headingValid);
            const effectiveLowConfMs =
              depthConfirmsTrack || minimapConfirmsTrack
                ? lowConfidenceMs * 2.2
                : lowConfidenceMs;

            if (
              depthConfirmsTrack &&
              freshDepth!.centerClearance > 0.55 &&
              Math.abs(target) < 0.25 &&
              typeof eng.resetRoadModel === "function"
            ) {
              eng.resetRoadModel();
            }

            lowConfAcc += dtMs;
            if (lowConfAcc >= effectiveLowConfMs) {
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
      const latestDepth = useInPageDepth
        ? dEngine.getStatus().lastResult
        : null;
      samples.push(
        eng.captureTile(
          surface,
          performance.now() - driveStart,
          finalSnap.axes,
          finalSnap.buttons,
          finalAnalysis,
          320,
          240,
          latestDepth,
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
      if (pause && !raceFinished) {
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
      {
        unwedgeCount,
        raceFinished,
        depthFramesUsed,
        minimapHeadingDeg,
        minimapTurnAhead,
        minimapDistance,
      },
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
    const dEngine = getDepthEngine();
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
        roadCurvature: 0,
        roadConfidence: 0,
        depth: dEngine.getStatus(),
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
      roadCurvature: analysis.roadCurvature,
      roadConfidence: analysis.roadConfidence,
      minimap: analysis.minimap,
      depth: dEngine.getStatus(),
    };
  }

  return {
    runChunk,
    driveServo,
    smartRescue,
    hideOverlay: hideSheetOverlay,
    resetRoadModel,
    initDepthEngine,
    getDepthStatus,
    inspectFrame,
  };
}
