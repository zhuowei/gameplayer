# `@gameplay/runtime` (`window.gameplayApi`)

Browser-injected virtual gamepad, 30 Hz pixel servo, safe pause-bounded chunk runner, and in-canvas contact-sheet compositor for playing unmodified streamed games in Chrome.

## Build & Test

```sh
# From repository root:
bun run build
bun test
```

Outputs `packages/runtime/gameplay-runtime.js` (standalone IIFE exposing `window.gameplayApi`).

## Injection (`chrome-devtools` MCP)

Pass the contents of `gameplay-runtime.js` inline to `evaluate_script` with `format: "script"` (avoid `sourcePath` if MCP `workspaceRoots` is unconfigured), then verify:

Verify (`version: "3.0.0"`):

```js
() => ({
  ready: Boolean(window.gameplayApi),
  version: window.gameplayApi?.version,
  frame: window.gameplayApi?.inspectFrame(),
})
```

## Key API Surface

- **Low-level gamepad (`Xbox / Standard Mapping`)**:
  - `BTN`: `{ A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9, L3: 10, R3: 11, DPAD_UP: 12, DPAD_DOWN: 13, DPAD_LEFT: 14, DPAD_RIGHT: 15, HOME: 16 }`
  - `setButton(index, value)`, `tapButton(index, holdMs?, settleMs?)`
  - `setStick(stickIndex, x, y)`, `pulseStick(stickIndex, x, y, holdMs?, settleMs?)`, `rampStick(stickIndex, targetX, targetY, durationMs, steps?)`
  - `resetAll()`, `getState()`, `sleep(ms)`
- **Orchestrated gameplay loops**:
  - `driveServo(options?)`: Unpauses (`BTN.A`), holds/modulates throttle (`BTN.Y` with curvature-coupled `throttleModulation`), runs 30 Hz multi-cue pixel analysis + thresholded-centroid PD steering, snapshots unobstructed HUD crops (`MINIMAP`, `TUTORIAL PROMPT`, `LOOKAHEAD & ALERT`) *before* pausing (`BTN.START`), resets inputs in `finally`, and displays an annotated 4×2 contact-sheet overlay.
  - `runChunk(async ({ api, shouldAbort, captureNow }) => { ... }, options?)`: Runs custom input maneuvers with automatic frame sampling, stuck abort signaling, pre-pause HUD snapshot, `try / finally` pause + `resetAll()`, and contact-sheet rendering.
  - `smartRescue(options?)`: Taps `BTN.BACK` (`8`) inside a safe `runChunk` to trigger in-game track rescue.
  - `hideOverlay()` / `inspectFrame()`: Removes the contact-sheet overlay for raw viewport inspection or returns instantaneous pixel telemetry.

See [skills/gameplay/SKILL.md](../../skills/gameplay/SKILL.md) and [docs/lessons-learned.md](../../docs/lessons-learned.md) for control architecture details, empirical post-mortems, and best practices.
