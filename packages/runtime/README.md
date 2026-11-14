# `@gameplay/runtime` (`window.gameplayApi` `v5.0.0`)

Browser-injected virtual gamepad, 30 Hz pure-pursuit servo with non-blocking in-page 3D depth Web Worker + stateful minimap odometry + local `autoUnwedge`, safe pause-bounded chunk runner, and pre-pause contact-sheet compositor for playing unmodified streamed games in Chrome.

## Build & Test

```sh
# From repository root:
bun run build
bun test
```

Outputs:
- `packages/runtime/gameplay-runtime.js`: Standalone IIFE exposing `window.gameplayApi` (`v5.0.0`).
- `.cache/gameplay-depth-bundle.js` (gitignored, generated when cached model exists): Offline `onnxruntime-web` WASM + quantized **Depth Anything V2 Small** (`280×210`) asset bundle.

## Injection (`chrome-devtools` MCP)

With `--workspace` configured on `chrome-devtools` MCP, inject via `evaluate_script` with `format: "script"` and `sourcePath`:
1. `.cache/gameplay-depth-bundle.js` (optional, enables in-page 3D depth)
2. `packages/runtime/gameplay-runtime.js`

Initialize and verify (`version: "5.0.0"`):

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

- **Low-level gamepad (`Xbox / Standard Mapping`)**:
  - `BTN`: `{ A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15, HOME: 16 }`
  - `setButton(index, value)`, `tapButton(index, holdMs?, settleMs?)`
  - `setStick(stickIndex, x, y)`, `pulseStick(stickIndex, x, y, holdMs?, settleMs?)`, `rampStick(stickIndex, targetX, targetY, durationMs, steps?)`
  - `resetAll()`, `getState()`, `sleep(ms)`
- **In-page 3D Depth (`src/depth.ts`)**:
  - `initDepthEngine()`: Spawns an in-memory `Blob` Web Worker running quantized Depth Anything V2 Small (`280×210` WASM, `~540–550ms/frame` non-blocking, with automatic `main_thread` fallback if CSP blocks `blob:` Workers).
  - `getDepthStatus()`: Returns `{ ready, mode, inputSize, inferencesCompleted, lastInferMs, lastResult }`.
- **Orchestrated gameplay loops (`src/controller.ts`, `src/vision.ts`)**:
  - `driveServo(options?)`: `7000ms` default adaptive horizon; unpauses (`BTN.A`), modulates throttle & tight-corner braking, fuses 30 Hz dual-band pure-pursuit road corridor (with striped-curb & underwater stone-pillar rejection), 30 Hz stateful `MinimapTracker` ego curvature (`turnAhead`), and live 3D depth corridor (`corridorOffsetX`), performs up to `maxUnwedgeAttempts` (default `2`) in-loop `autoUnwedge` recoveries when wedged, halts cleanly on post-race results (`stopOnRaceFinish` skipping `BTN.START` pause), snapshots unobstructed HUD crops before pausing, resets inputs in `finally`, and displays an annotated 4×2 contact sheet.
  - `runChunk(async ({ api, shouldAbort, captureNow }) => { ... }, options?)`: Runs custom input maneuvers with frame sampling, stuck abort signaling, pre-pause HUD snapshot, `try / finally` pause + `resetAll()`, and contact-sheet rendering.
  - `smartRescue(options?)` / `resetRoadModel()` / `hideOverlay()` / `inspectFrame()`.

See [skills/gameplay/SKILL.md](../../skills/gameplay/SKILL.md) and [docs/lessons-learned.md](../../docs/lessons-learned.md) for architecture details and empirical evaluations.
