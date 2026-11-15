import { BTN, clamp, type GamepadController } from "./gamepad";
import {
  BrowserDepthEngine,
  type DepthEngineLike,
  type DepthEngineStatus,
} from "./depth";
import type {
  AutoCombatSweepOptions,
  ChunkHistoryEntry,
  ChunkOptions,
  ChunkResult,
  CoverPeekBurstOptions,
  DriveServoOptions,
  FrameSample,
  GtavDriveOptions,
  GtavRadarReading,
  NavigateToObjectiveOptions,
  SprintMoveOptions,
  SwitchCharacterOptions,
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
  gtavDrive(options?: GtavDriveOptions): Promise<ChunkResult>;
  smartRescue(options?: ChunkOptions): Promise<ChunkResult>;
  coverPeekBurst(options?: CoverPeekBurstOptions): Promise<ChunkResult>;
  sprintMove(options?: SprintMoveOptions): Promise<ChunkResult>;
  navigateToObjective(options?: NavigateToObjectiveOptions): Promise<ChunkResult>;
  autoCombatSweep(options?: AutoCombatSweepOptions): Promise<ChunkResult>;
  switchCharacter(options?: SwitchCharacterOptions): Promise<ChunkResult>;
  readGtavRadar(): GtavRadarReading | null;
  getRecentHistory(): ChunkHistoryEntry[];
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
  const recentHistory: ChunkHistoryEntry[] = [];
  const MAX_HISTORY_ENTRIES = 12;

  function recordHistory(entry: ChunkHistoryEntry): void {
    recentHistory.push(entry);
    if (recentHistory.length > MAX_HISTORY_ENTRIES) {
      recentHistory.shift();
    }
  }

  function getRecentHistory(): ChunkHistoryEntry[] {
    return recentHistory.slice();
  }

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

    recordHistory({
      timestamp: Date.now(),
      label,
      stopReason,
      durationMs,
      avgMotion,
      stuckDetected,
      ok,
    });

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
      if (resetOnEnd) {
        gamepad.resetAll();
      }
      if (pause) {
        try {
          await gamepad.tapButton(pauseButton, 90, pauseSettleMs);
        } catch {
          // ignore secondary error during pause cleanup
        }
        if (resetOnEnd) {
          gamepad.resetAll();
        }
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
      steerBiasFn,
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
      unwedgeReverseMs = 580,
      unwedgeForwardMs = 560,
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
            freshDepth.wallOrObstacleAhead && freshDepth.centerClearance < 0.38
              ? 0.78
              : freshDepth.wallOrObstacleAhead || freshDepth.centerClearance < 0.52
                ? 0.58
                : 0.22;
          visualTarget =
            (1 - dWeight) * visualTarget +
            dWeight * clamp(freshDepth.corridorOffsetX, -1, 1);
        }

        if (typeof depthSteerHint === "number" && Number.isFinite(depthSteerHint)) {
          const w = clamp(depthHintWeight, 0, 1);
          visualTarget = (1 - w) * visualTarget + w * clamp(depthSteerHint, -1, 1);
        }

        const dynamicBias =
          typeof steerBiasFn === "function" ? steerBiasFn(surface) : 0;
        const target = clamp(visualTarget + steerBias + dynamicBias, -1, 1);
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
          const pinnedAgainst3DObstacle =
            freshDepth !== null &&
            freshDepth.wallOrObstacleAhead &&
            freshDepth.centerClearance < 0.22 &&
            analysis.motionScore < Math.max(stuckThreshold, 0.03);
          if (
            stopOnStuck &&
            (analysis.motionScore < stuckThreshold || pinnedAgainst3DObstacle)
          ) {
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
      if (resetOnEnd) {
        gamepad.resetAll();
      }
      if (pause && !raceFinished) {
        try {
          await gamepad.tapButton(pauseButton, 90, pauseSettleMs);
        } catch {
          // ignore
        }
        if (resetOnEnd) {
          gamepad.resetAll();
        }
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

  /**
   * 3rd-person cover-peek-fire burst that always releases aim/fire before
   * returning so the character ducks back into cover during LLM turn gaps.
   */
  async function coverPeekBurst(
    options: CoverPeekBurstOptions = {},
  ): Promise<ChunkResult> {
    const {
      aimButton = BTN.LT,
      fireButton = BTN.RT,
      coverButton = BTN.RB,
      enterCover = false,
      aimSettleMs = 180,
      aimX = 0,
      aimY = 0,
      aimNudgeMs = 0,
      bursts = 2,
      burstMs = 220,
      gapMs = 120,
      special = false,
      unpause = false,
      pause = false,
      stopOnStuck = false,
      label = "cover-peek",
      ...rest
    } = options;

    return runChunk(
      async ({ api, shouldAbort }) => {
        if (special) {
          api.setButton(BTN.L3, 1);
          api.setButton(BTN.R3, 1);
          await api.sleep(90);
          api.setButton(BTN.L3, 0);
          api.setButton(BTN.R3, 0);
          await api.sleep(80);
        }
        if (enterCover) {
          await api.tapButton(coverButton, 80, 140);
        }
        api.setButton(aimButton, 1);
        await api.sleep(aimSettleMs);
        if (aimNudgeMs > 0 && (aimX !== 0 || aimY !== 0)) {
          api.setStick(1, aimX, aimY);
          await api.sleep(aimNudgeMs);
          api.setStick(1, 0, 0);
        }
        for (let i = 0; i < bursts && !shouldAbort(); i++) {
          api.setButton(fireButton, 1);
          await api.sleep(burstMs);
          api.setButton(fireButton, 0);
          if (i + 1 < bursts && gapMs > 0) {
            await api.sleep(gapMs);
          }
        }
        api.setStick(1, 0, 0);
        api.setButton(fireButton, 0);
        api.setButton(aimButton, 0);
        await api.sleep(100);
      },
      {
        ...rest,
        unpause,
        pause,
        stopOnStuck,
        label,
      },
    );
  }

  /**
   * 3D on-foot camera-yaw + sprint movement with wall-snag early abort and
   * optional end-of-chunk cover snap.
   */
  async function sprintMove(
    options: SprintMoveOptions = {},
  ): Promise<ChunkResult> {
    const {
      yawX = 0,
      yawY = 0,
      yawMs = 0,
      moveX = 0,
      moveY = -1,
      sprint = true,
      sprintButton = BTN.A,
      durationMs = 1200,
      endCover = false,
      coverButton = BTN.RB,
      special = false,
      autoSpecialOnLowHealth = true,
      abortOnLowHealth = true,
      unpause = false,
      pause = false,
      label = "sprint-move",
      ...rest
    } = options;

    return runChunk(
      async ({ api, shouldAbort }) => {
        const eng = getEngine();
        const surface = eng.findVideoSurface();
        let specialUsed = false;

        const triggerSpecial = async () => {
          specialUsed = true;
          api.setButton(BTN.L3, 1);
          api.setButton(BTN.R3, 1);
          await api.sleep(90);
          api.setButton(BTN.L3, 0);
          api.setButton(BTN.R3, 0);
          await api.sleep(40);
        };

        if (special) {
          await triggerSpecial();
        }
        if (yawMs > 0 && (yawX !== 0 || yawY !== 0)) {
          api.setStick(1, yawX, yawY);
          await api.sleep(yawMs);
          api.setStick(1, 0, 0);
          await api.sleep(50);
        }
        api.setStick(0, moveX, moveY);
        if (sprint) {
          api.setButton(sprintButton, 1);
        }
        const stepMs = 150;
        const steps = Math.max(1, Math.ceil(durationMs / stepMs));
        for (let i = 0; i < steps && !shouldAbort(); i++) {
          if (abortOnLowHealth && surface && typeof eng.readGtavRadar === "function") {
            const radar = eng.readGtavRadar(surface);
            if (radar && radar.lowHealth) {
              if (autoSpecialOnLowHealth && !specialUsed) {
                await triggerSpecial();
              } else {
                break;
              }
            }
          }
          await api.sleep(Math.min(stepMs, Math.max(50, durationMs - i * stepMs)));
        }
        if (sprint) {
          api.setButton(sprintButton, 0);
        }
        api.setStick(0, 0, 0);
        if (endCover) {
          await api.tapButton(coverButton, 80, 120);
        }
      },
      {
        ...rest,
        unpause,
        pause,
        label,
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

  function readGtavRadar(): GtavRadarReading | null {
    const eng = getEngine();
    const surface = eng.findVideoSurface();
    if (!surface || typeof eng.readGtavRadar !== "function") return null;
    return eng.readGtavRadar(surface);
  }

  /**
   * Closed-loop GTA V combat sweep: checks minimap radar + health at each
   * cycle, fires LT+RT bursts from cover, ducks between bursts, and triggers
   * L3+R3 Special or aborts safely into cover if health drops.
   */
  async function autoCombatSweep(
    options: AutoCombatSweepOptions = {},
  ): Promise<ChunkResult> {
    const {
      aimButton = BTN.LT,
      fireButton = BTN.RT,
      coverButton = BTN.RB,
      enterCover = false,
      maxDurationMs = 3500,
      maxCycles = 4,
      aimSettleMs = 160,
      burstMs = 220,
      duckMs = 180,
      special = false,
      autoSpecialOnLowHealth = true,
      autoPan = true,
      panMs = 180,
      stopWhenClear = true,
      unpause = false,
      pause = false,
      stopOnStuck = false,
      label = "combat-sweep",
      ...rest
    } = options;

    return runChunk(
      async ({ api, shouldAbort }) => {
        const eng = getEngine();
        const surface = eng.findVideoSurface();
        let specialUsed = false;
        let sawEnemies = false;
        let clearStreak = 0;
        const startAt = performance.now();

        const triggerSpecial = async () => {
          specialUsed = true;
          api.setButton(BTN.L3, 1);
          api.setButton(BTN.R3, 1);
          await api.sleep(90);
          api.setButton(BTN.L3, 0);
          api.setButton(BTN.R3, 0);
          await api.sleep(60);
        };

        if (special) {
          await triggerSpecial();
        }
        if (enterCover) {
          await api.tapButton(coverButton, 80, 120);
        }

        for (let i = 0; i < maxCycles && !shouldAbort(); i++) {
          if (performance.now() - startAt >= maxDurationMs) break;
          const radar =
            surface && typeof eng.readGtavRadar === "function"
              ? eng.readGtavRadar(surface)
              : null;
          if (radar && radar.radarVisible) {
            if (radar.enemyPixels > 0) {
              sawEnemies = true;
              clearStreak = 0;
            } else if (stopWhenClear && sawEnemies) {
              clearStreak++;
              if (clearStreak >= 2) break;
            }
          }
          if (radar && radar.lowHealth) {
            if (autoSpecialOnLowHealth && !specialUsed) {
              await triggerSpecial();
            } else {
              break;
            }
          }
          if (autoPan && radar && radar.enemiesAhead === 0) {
            if (radar.enemiesLeft > radar.enemiesRight && radar.enemiesLeft > 0) {
              api.setStick(1, -0.75, 0);
              await api.sleep(panMs);
              api.setStick(1, 0, 0);
            } else if (radar.enemiesRight > 0) {
              api.setStick(1, 0.75, 0);
              await api.sleep(panMs);
              api.setStick(1, 0, 0);
            } else if (radar.enemiesBehind > 0) {
              api.setStick(1, 0.9, 0);
              await api.sleep(Math.round(panMs * 1.6));
              api.setStick(1, 0, 0);
            }
          }
          api.setButton(aimButton, 1);
          await api.sleep(aimSettleMs);
          api.setButton(fireButton, 1);
          await api.sleep(burstMs);
          api.setButton(fireButton, 0);
          api.setButton(aimButton, 0);
          if (i + 1 < maxCycles && duckMs > 0) {
            await api.sleep(duckMs);
          }
        }
        api.setStick(1, 0, 0);
        api.setButton(fireButton, 0);
        api.setButton(aimButton, 0);
      },
      {
        ...rest,
        unpause,
        pause,
        stopOnStuck,
        label,
      },
    );
  }

  /**
   * Closed-loop on-foot navigation toward the GTA V minimap objective blip
   * (yellow/green/blue): continuously yaws camera toward objectiveAngleDeg,
   * sprints forward, unsticks doorway snags via brief strafes, and stops early
   * on arrival, enemy contact, or low health.
   */
  async function navigateToObjective(
    options: NavigateToObjectiveOptions = {},
  ): Promise<ChunkResult> {
    const {
      maxDurationMs = 5000,
      tickMs = 65,
      sprint = true,
      sprintButton = BTN.A,
      stopDist = 0.1,
      stopOnEnemy = true,
      enemyThreshold = 6,
      stopOnLowHealth = true,
      autoSpecialOnLowHealth = true,
      endCover = false,
      coverButton = BTN.RB,
      yawGain = 1.0,
      unstickStrafe = true,
      unpause = false,
      pause = false,
      stopOnStuck = false,
      label = "nav-objective",
      ...rest
    } = options;

    let customStopReason = "";
    const result = await runChunk(
      async ({ api, shouldAbort }) => {
        const eng = getEngine();
        const surface = eng.findVideoSurface();
        let specialUsed = false;
        let lowMotionMs = 0;
        let strafeDir = 1;
        let strafeUntil = 0;
        const startAt = performance.now();

        const triggerSpecial = async () => {
          specialUsed = true;
          api.setButton(BTN.L3, 1);
          api.setButton(BTN.R3, 1);
          await api.sleep(90);
          api.setButton(BTN.L3, 0);
          api.setButton(BTN.R3, 0);
          await api.sleep(40);
        };

        while (!shouldAbort()) {
          const now = performance.now();
          if (now - startAt >= maxDurationMs) {
            customStopReason = "max_duration";
            break;
          }

          const radar =
            surface && typeof eng.readGtavRadar === "function"
              ? eng.readGtavRadar(surface)
              : null;

          if (radar && radar.lowHealth) {
            if (autoSpecialOnLowHealth && !specialUsed) {
              await triggerSpecial();
            } else if (stopOnLowHealth) {
              customStopReason = "low_health";
              break;
            }
          }

          if (
            stopOnEnemy &&
            radar &&
            radar.radarVisible &&
            radar.enemyPixels >= enemyThreshold
          ) {
            customStopReason = "enemy_detected";
            break;
          }

          if (
            radar &&
            radar.objectiveVisible &&
            radar.objectiveDist !== null &&
            radar.objectiveDist <= stopDist
          ) {
            customStopReason = "reached_objective";
            break;
          }

          let yawX = 0;
          let moveY = -1;
          let moveX = 0;

          if (
            radar &&
            radar.objectiveVisible &&
            radar.objectiveAngleDeg !== null
          ) {
            const ang = radar.objectiveAngleDeg;
            if (Math.abs(ang) > 6) {
              yawX = clamp((ang / 65) * yawGain, -0.95, 0.95);
            }
            if (Math.abs(ang) > 105) {
              // Turn camera first before sprinting forward into a wall
              moveY = 0;
            }
          }

          if (unstickStrafe && moveY < 0 && surface) {
            const sample = eng.sampleAnalysis(surface);
            if (sample.motionScore < 0.012 && now - startAt > 500) {
              lowMotionMs += tickMs;
            } else {
              lowMotionMs = 0;
            }
            if (lowMotionMs >= 450 && now >= strafeUntil) {
              strafeDir =
                depthEngine?.isReady() && depthEngine.getLastResult()
                  ? depthEngine.getLastResult()!.corridorOffsetX >= 0
                    ? 1
                    : -1
                  : -strafeDir;
              strafeUntil = now + 350;
              lowMotionMs = 0;
            }
            if (now < strafeUntil) {
              moveX = 0.85 * strafeDir;
              moveY = -0.35;
            }
          }

          api.setStick(1, yawX, 0);
          api.setStick(0, moveX, moveY);
          if (sprint && moveY < -0.2) {
            api.setButton(sprintButton, 1);
          } else if (sprint) {
            api.setButton(sprintButton, 0);
          }

          await api.sleep(tickMs);
        }

        if (sprint) {
          api.setButton(sprintButton, 0);
        }
        api.setStick(0, 0, 0);
        api.setStick(1, 0, 0);
        if (endCover) {
          await api.tapButton(coverButton, 80, 120);
        }
      },
      {
        ...rest,
        unpause,
        pause,
        stopOnStuck,
        label,
      },
    );

    if (customStopReason) {
      return { ...result, stopReason: customStopReason };
    }
    return result;
  }

  /**
   * GTA V safe driving wrapper around driveServo: uses RT for gas (never Y,
   * which exits the vehicle), blends minimap GPS/objective steering bias when
   * radar is visible, and disables pause/unpause/race-finish hooks.
   */
  async function gtavDrive(
    options: GtavDriveOptions = {},
  ): Promise<ChunkResult> {
    const {
      useRadarGps = true,
      radarGpsWeight = 0.35,
      steerBiasFn,
      ...rest
    } = options;
    const eng = getEngine();
    const gpsBiasFn =
      steerBiasFn ??
      (useRadarGps
        ? (surface: HTMLCanvasElement | HTMLVideoElement) => {
            if (typeof eng.readGtavRadar !== "function") return 0;
            const radar = eng.readGtavRadar(surface);
            if (!radar || !radar.radarVisible) return 0;
            return clamp(radar.gpsSteerBias * radarGpsWeight, -0.45, 0.45);
          }
        : undefined);
    return driveServo({
      gasButton: BTN.RT,
      unpause: false,
      pause: false,
      stopOnRaceFinish: false,
      label: "gtav-drive",
      steerBiasFn: gpsBiasFn,
      ...rest,
    });
  }

  async function switchCharacter(
    options: SwitchCharacterOptions = {},
  ): Promise<ChunkResult> {
    const {
      dirX = 1,
      dirY = 0,
      holdMs = 550,
      settleMs = 250,
      unpause = false,
      pause = false,
      stopOnStuck = false,
      label = "switch-char",
      ...rest
    } = options;

    return runChunk(
      async ({ api }) => {
        api.setButton(BTN.DPAD_DOWN, 1);
        await api.sleep(220);
        api.setStick(1, dirX, dirY);
        await api.sleep(holdMs);
        // Release DPAD_DOWN while stick is still held to confirm selection
        api.setButton(BTN.DPAD_DOWN, 0);
        await api.sleep(80);
        api.setStick(1, 0, 0);
        if (settleMs > 0) {
          await api.sleep(settleMs);
        }
      },
      {
        ...rest,
        unpause,
        pause,
        stopOnStuck,
        label,
      },
    );
  }

  return {
    runChunk,
    driveServo,
    gtavDrive,
    smartRescue,
    coverPeekBurst,
    sprintMove,
    navigateToObjective,
    autoCombatSweep,
    switchCharacter,
    readGtavRadar,
    getRecentHistory,
    hideOverlay: hideSheetOverlay,
    resetRoadModel,
    initDepthEngine,
    getDepthStatus,
    inspectFrame,
  };
}
