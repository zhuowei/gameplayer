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
  roadConfidence: number;
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
  /** Settle wait after unpause before actions begin (default: 120ms) */
  unpauseSettleMs?: number;
  /** Settle wait after pause before ending capture (default: 100ms) */
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
  /** Maximum active driving duration in ms (default: 3000) */
  maxDurationMs?: number;
  /** Control tick period in ms (default: 33ms / ~30Hz) */
  tickMs?: number;
  /** Proportional steering gain (default: 0.95) */
  kp?: number;
  /** Derivative steering damping (default: 0.25) */
  kd?: number;
  /** Maximum left stick X magnitude (default: 0.85) */
  maxSteer?: number;
  /** Throttle button index (default: 3 / Y) */
  gasButton?: number;
  /** Optional steering bias added to visual target offset (-1..1) */
  steerBias?: number;
  /** Stop early if top HUD banner changes sharply after cooldown (default: true) */
  stopOnBannerChange?: boolean;
  bannerDeltaThreshold?: number;
  /** Stop early if navigable corridor confidence falls below threshold (default: 0.22) */
  stopOnLowConfidence?: boolean;
  minConfidence?: number;
  lowConfidenceMs?: number;
  /** Stop early if red HUD warning ("WRONG WAY") dominates */
  stopOnRedAlert?: boolean;
  redAlertThreshold?: number;
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
  stuckDetected: boolean;
  finalState: GamepadSnapshot;
  /** Compact JPEG data URL of the annotated contact sheet (if requested/created) */
  sheetDataUrl?: string;
}
