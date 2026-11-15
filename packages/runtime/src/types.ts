export interface StickState {
  x: number;
  y: number;
}

export interface GamepadSnapshot {
  axes: number[];
  buttons: number[];
  timestamp: number;
}

export interface CropRegion {
  label: string;
  /** Normalized coordinates [0..1] relative to video surface */
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FrameSample {
  tMs: number;
  width: number;
  height: number;
  /** RGB thumbnail canvas or OffscreenCanvas data stored as canvas */
  canvas: HTMLCanvasElement;
  axes: number[];
  buttons: number[];
  motionScore: number;
  bannerDelta: number;
  redAlertRatio: number;
  roadOffsetX: number;
  roadCurvature?: number;
  roadConfidence: number;
  depthCorridorX?: number;
  depthClearance?: number;
  minimapTurnAhead?: number;
  minimapHeadingDeg?: number | null;
}

export interface ChunkOptions {
  /** Whether to unpause before running actions (default: true) */
  unpause?: boolean;
  /** Button index to tap for unpause (default: 0 / A) */
  unpauseButton?: number;
  /** Whether to re-pause after actions finish (default: true) */
  pause?: boolean;
  /** Button index to tap for pause (default: 9 / Start) */
  pauseButton?: number;
  /** Settle wait after unpause before actions begin (default: 220ms) */
  unpauseSettleMs?: number;
  /** Settle wait after pause before ending capture (default: 150ms) */
  pauseSettleMs?: number;
  /** Sample interval in ms during active window (default: 140ms) */
  sampleIntervalMs?: number;
  /** Keep gas (button 3 by default) held across unpause/pause transition */
  holdGasButton?: number | null;
  /** Release all inputs in finally block after pausing (default: true) */
  resetOnEnd?: boolean;
  /** Stop early if frame motion drops below stuckThreshold for stuckDurationMs */
  stopOnStuck?: boolean;
  stuckThreshold?: number;
  stuckDurationMs?: number;
  /** Render and show the annotated contact-sheet overlay on screen (default: true) */
  showSheetOverlay?: boolean;
  /** Custom zoomed crop regions on contact sheet */
  crops?: CropRegion[];
  /** Label shown in sheet header */
  label?: string;
}

export interface DriveServoOptions extends ChunkOptions {
  /** Maximum active driving duration in ms (default: 7000) */
  maxDurationMs?: number;
  /** Control tick period in ms (default: 33ms / ~30Hz) */
  tickMs?: number;
  /** Proportional steering gain (default: 1.25) */
  kp?: number;
  /** Derivative steering damping (default: 0.25) */
  kd?: number;
  /** Maximum left stick X magnitude (default: 0.95) */
  maxSteer?: number;
  /** Throttle button index (default: 3 / Y) */
  gasButton?: number;
  /** Automatically feather throttle when steering hard into curves (default: true) */
  throttleModulation?: boolean;
  /** Tap brief brake pulses when high-speed hard cornering exceeds turning radius (default: true) */
  autoCornerBrake?: boolean;
  /** Optional additive steering bias (-1..1) */
  steerBias?: number;
  /** Optional dynamic steering bias callback evaluated each tick */
  steerBiasFn?: (surface: HTMLCanvasElement | HTMLVideoElement) => number;
  /** Optional 3D free-space / minimap steering target (-1..1) from host `perceive` CLI */
  depthSteerHint?: number;
  /** Blend weight [0..1] for depthSteerHint when provided (default: 0.30) */
  depthHintWeight?: number;
  /** Stop early if top HUD banner changes sharply after cooldown (default: false) */
  stopOnBannerChange?: boolean;
  bannerDeltaThreshold?: number;
  /** Stop early if navigable corridor confidence falls below threshold (default: true / 0.25) */
  stopOnLowConfidence?: boolean;
  minConfidence?: number;
  lowConfidenceMs?: number;
  /** Stop early if HUD warning ("WRONG WAY!") dominates */
  stopOnRedAlert?: boolean;
  redAlertThreshold?: number;
  /** Automatically reverse + re-orient inside the 30 Hz loop if wedged against a wall (default: true) */
  autoUnwedge?: boolean;
  maxUnwedgeAttempts?: number;
  unwedgeReverseMs?: number;
  unwedgeForwardMs?: number;
  /** Use in-page Web Worker / WASM Depth Anything V2 Small if initialized (default: true) */
  useInPageDepth?: boolean;
  /** Use stateful 30 Hz temporal minimap odometry & ego curvature lookahead (default: true) */
  useMinimapOdometry?: boolean;
  /** Halt cleanly without pressing Pause if post-race results modal appears (default: true) */
  stopOnRaceFinish?: boolean;
}

export interface ChunkResult {
  ok: boolean;
  error?: string;
  label: string;
  stopReason: string;
  durationMs: number;
  framesCaptured: number;
  avgMotion: number;
  minMotion: number;
  maxBannerDelta: number;
  maxRedAlertRatio: number;
  avgRoadConfidence: number;
  meanSteerX: number;
  meanCurvature: number;
  stuckDetected: boolean;
  unwedgeCount?: number;
  raceFinished?: boolean;
  depthFramesUsed?: number;
  minimapHeadingDeg?: number | null;
  minimapTurnAhead?: number;
  minimapDistance?: number;
  finalState: GamepadSnapshot;
  /** Compact JPEG data URL of the annotated contact sheet (if requested/created) */
  sheetDataUrl?: string;
}

export interface CoverPeekBurstOptions extends ChunkOptions {
  aimButton?: number;
  fireButton?: number;
  coverButton?: number;
  enterCover?: boolean;
  aimSettleMs?: number;
  aimX?: number;
  aimY?: number;
  aimNudgeMs?: number;
  bursts?: number;
  burstMs?: number;
  gapMs?: number;
  special?: boolean;
}

export interface SprintMoveOptions extends ChunkOptions {
  yawX?: number;
  yawY?: number;
  yawMs?: number;
  moveX?: number;
  moveY?: number;
  sprint?: boolean;
  sprintButton?: number;
  durationMs?: number;
  endCover?: boolean;
  coverButton?: number;
  special?: boolean;
  autoSpecialOnLowHealth?: boolean;
  abortOnLowHealth?: boolean;
}

export interface ChunkHistoryEntry {
  timestamp: number;
  label: string;
  stopReason: string;
  durationMs: number;
  avgMotion: number;
  stuckDetected: boolean;
  ok: boolean;
}

export interface GtavRadarReading {
  radarVisible: boolean;
  healthPct: number;
  lowHealth: boolean;
  enemyPixels: number;
  enemiesAhead: number;
  enemiesLeft: number;
  enemiesRight: number;
  enemiesBehind: number;
  closestEnemyDist: number | null;
  objectiveVisible: boolean;
  objectiveColor: "yellow" | "green" | "blue" | null;
  objectiveAngleDeg: number | null;
  objectiveDist: number | null;
  objectivePixels: number;
  gpsSteerBias: number;
}

export interface AutoCombatSweepOptions extends ChunkOptions {
  aimButton?: number;
  fireButton?: number;
  coverButton?: number;
  enterCover?: boolean;
  maxDurationMs?: number;
  maxCycles?: number;
  aimSettleMs?: number;
  burstMs?: number;
  duckMs?: number;
  special?: boolean;
  autoSpecialOnLowHealth?: boolean;
  autoPan?: boolean;
  panMs?: number;
  stopWhenClear?: boolean;
}

export interface NavigateToObjectiveOptions extends ChunkOptions {
  maxDurationMs?: number;
  tickMs?: number;
  sprint?: boolean;
  sprintButton?: number;
  stopDist?: number;
  stopOnEnemy?: boolean;
  enemyThreshold?: number;
  stopOnLowHealth?: boolean;
  autoSpecialOnLowHealth?: boolean;
  endCover?: boolean;
  coverButton?: number;
  yawGain?: number;
  unstickStrafe?: boolean;
}

export interface GtavDriveOptions extends DriveServoOptions {
  useRadarGps?: boolean;
  radarGpsWeight?: number;
}

export interface SwitchCharacterOptions extends ChunkOptions {
  dirX?: number;
  dirY?: number;
  holdMs?: number;
  settleMs?: number;
}

export interface WaitForRadarOptions {
  visible?: boolean;
  timeoutMs?: number;
  pollMs?: number;
}
