# `@gameplay/runtime` (`window.gameplayApi` `v5.0.1`)

Browser-injected virtual gamepad, 30 Hz pure-pursuit servo with non-blocking in-page 3D depth Web Worker + stateful minimap odometry (with bounded-width cobblestone stroke filtering) + local `autoUnwedge`, safe pause-bounded chunk runner (neutralizing inputs before pressing `BTN.START`), and pre-pause contact-sheet compositor for playing unmodified streamed games in Chrome.

## Build & Test

```sh
# From repository root:
bun run build
bun test
```

Outputs:
- `packages/runtime/gameplay-runtime.js`: Standalone IIFE exposing `window.gameplayApi` (`v5.0.1`).
- `.cache/gameplay-depth-bundle.js` (gitignored, generated when cached model exists): Offline `onnxruntime-web` WASM + quantized **Depth Anything V2 Small** (`280×210`) asset bundle.

## Injection (`chrome-devtools` MCP)

With `--workspace` configured on `chrome-devtools` MCP, inject via `evaluate_script` with `format: "script"` and `sourcePath`:
1. `.cache/gameplay-depth-bundle.js` (optional, enables in-page 3D depth)
2. `packages/runtime/gameplay-runtime.js`

Initialize and verify (`version: "5.0.1"`):

```js
async () => ({
  hasApi: Boolean(window.gameplayApi),
  version: window.gameplayApi?.version,
  depth: await window.gameplayApi?.initDepthEngine(),
  frame: window.gameplayApi?.inspectFrame(),
})
```

*(If `--workspace` is unconfigured on MCP, pass `packages/runtime/gameplay-runtime.js` inline via `function` with `format: "script"` instead of `sourcePath`.)*

## Key API Surface

- **Low-level gamepad (`Xbox / Standard Mapping`, WebIDL-compatible)**:
  - Adopts native `Gamepad`, `GamepadButton`, and `GamepadEvent` prototypes (safely shadowing WebIDL prototype getters), emits `performance.now()` timestamps, and returns `[simGamepad, null, null, null]` from `navigator.getGamepads()`.
  - `BTN`: `{ A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15, HOME: 16 }`
  - `setButton(index, value)`, `tapButton(index, holdMs?, settleMs?)`
  - `setStick(stickIndex, x, y)` and `pulseStick(stickIndex, x, y, holdMs?, settleMs?)` accept `0 | 1 | "left" | "right"` and throw on non-integer/out-of-bounds indices; `rampStick(stickIndex, targetX, targetY, durationMs, steps?)` accepts `0 | 1`.
  - `resetAll()`, `getState()`, `sleep(ms)`
- **In-page 3D Depth (`src/depth.ts`)**:
  - `initDepthEngine()`: Spawns an in-memory `Blob` Web Worker running quantized Depth Anything V2 Small (`280×210` WASM, `~540–550ms/frame` non-blocking, with automatic `main_thread` fallback if CSP blocks `blob:` Workers).
  - `getDepthStatus()`: Returns `{ ready, mode, inputSize, inferencesCompleted, lastInferMs, lastResult }`.
- **Orchestrated gameplay loops (`src/controller.ts`, `src/vision.ts`)**:
  - `driveServo(options?)`: `7000ms` default adaptive horizon; unpauses (`BTN.A`), modulates throttle & tight-corner braking, fuses 30 Hz dual-band pure-pursuit road corridor (with striped-curb & underwater stone-pillar rejection), 30 Hz stateful `MinimapTracker` ego curvature (`turnAhead`), and live 3D depth corridor (`corridorOffsetX`), performs up to `maxUnwedgeAttempts` (default `2`) in-loop `autoUnwedge` recoveries when wedged, halts cleanly on post-race results (`stopOnRaceFinish` skipping `BTN.START` pause), snapshots unobstructed HUD crops before pausing, resets inputs in `finally`, and displays an annotated 4×2 contact sheet.
  - `runChunk(async ({ api, shouldAbort, captureNow }) => { ... }, options?)`: Runs custom input maneuvers with frame sampling, stuck abort signaling, pre-pause HUD snapshot, `try / finally` pause + `resetAll()`, and contact-sheet rendering (pass `{ unpause: false, pause: false }` for unpausable online games or continuous unpaused 3D play—including games where Pause opens an opaque menu or `BTN.A` does not resume).
  - `gtavDrive(options?)`: GTA V vehicle wrapper around `driveServo` defaulting `{ gasButton: BTN.RT, unpause: false, pause: false, stopOnRaceFinish: false, showSheetOverlay: false, useRadarGps: true, radarGpsWeight: 0.35 }` (avoids the `BTN.Y` exit-vehicle trap and blends minimap GPS/objective steering bias).
  - `readGtavRadar()`: Real-time `128×96` bottom-left minimap reader returning `{ radarVisible, healthPct, lowHealth, enemyPixels, enemiesAhead, enemiesLeft, enemiesRight, enemiesBehind, closestEnemyDist, enemyAngleDeg, objectiveVisible, objectiveColor, objectiveAngleDeg, objectiveDist, objectivePixels, gpsSteerBias }`, guarding `lowHealth` against cutscene hidden HUDs (`healthPct > 0.03 || redBarRatio > 0.15`) and flashing red alarm lights (`healthPct < 0.45`).
  - `readGtavReticle()`: Samples the center reticle patch (`32×32`) and returns `{ state: "enemy" | "friendly" | "neutral" | "none", redPixels, greenPixels, whitePixels }` (`"friendly"` green-lock guard; note 4:2:0 subsampling/red lighting can wash out 2×2px dots to `"neutral"`/`"none"`).
  - `navigateToObjective(options?)`: Closed-loop ~15 Hz on-foot minimap objective servo (`yellow`/`green`/`blue` blip tracking, doorway `unstickStrafe`, and `"reached_objective"` / `"enemy_detected"` / `"low_health"` interrupts; defaults `showSheetOverlay: false`).
  - `autoCombatSweep(options?)`: Closed-loop multi-cycle cover peek-fire (`LT` + `RT` bursts, defaults `showSheetOverlay: false`) with inverse-distance-weighted `enemyAngleDeg` damped pulse-settle `autoPan` (`panDeadbandDeg: 8`), `requestAnimationFrame`-synced `verifyReticle` / `requireEnemyReticle` checks (`reticleScanMs: 900`), `stopWhenClear`, `120ms` mid-peek `lowHealth` cover-abort + Special (`L3+R3`), and guaranteed `LT`/`RT` release into cover.
  - `activateSpecial(options?)`: Presses `L3 + R3` simultaneously (`{ holdMs: 90, settleMs: 60 }`) to activate the active character's Special Ability and returns `readGtavRadar()`.
  - `sprintMove(options?)` & `coverPeekBurst(options?)`: Unpaused 3D sprint-to-cover (with optional `special: true`, 150ms mid-sprint `readGtavRadar()` `abortOnLowHealth`, and `endCover: true`; pass `showSheetOverlay: false` in live combat) and single-exchange cover peek-fire (`showSheetOverlay: false` default).
  - `switchCharacter(options?)`, `waitForRadar(options?)`, & `retryMission(options?)`: Atomic `DPAD_DOWN` + Right Stick character switch (`showSheetOverlay: false` default), HUD radar state polling, and atomic `BTN.A` Retry + `waitForRadar`.
  - `getRecentHistory()`: 12-entry ring buffer of recent chunk telemetry (`label`, `stopReason`, `durationMs`, `avgMotion`, `stuckDetected`, `ok`).
  - `smartRescue(options?)` / `resetRoadModel()` / `hideOverlay()` / `inspectFrame()`.

See [skills/gameplay/SKILL.md](../../skills/gameplay/SKILL.md) and [docs/lessons-learned.md](../../docs/lessons-learned.md) for architecture details and empirical evaluations.
