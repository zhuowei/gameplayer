---
name: gameplay
description: >-
  Use this skill when playing or testing unmodified video games streamed in Chrome
  (such as MoonlightWeb, SuperTuxKart, or Xbox Cloud/Remote Play) using virtual
  controller inputs (window.gameplayApi) and rendered video pixels.
---

# Gameplay Agent Skill (Two-Loop Servo + Contact Sheets)

Play games strictly through rendered video pixels (`<canvas>` / `<video>`) and virtual controller inputs (`window.gameplayApi`)—never modifying game files or reading engine internals.

For game-specific bindings, track hazards, and empirical post-mortems, load on demand:
- **SuperTuxKart controls, pause quirks & tutorial track guide**: [references/supertuxkart.md](./references/supertuxkart.md)
- **Cross-game architecture & failure lessons**: [docs/lessons-learned.md](../../docs/lessons-learned.md)

---

## 1. Inject & Verify `window.gameplayApi`

1. **Find target page**: Call `chrome-devtools` MCP `list_pages` to get `pageId`.
2. **Inject runtime inline** (once per page load):
   - Minify or read `packages/runtime/gameplay-runtime.js` and pass its text inline to `evaluate_script` with `format: "script"` (avoid `sourcePath`, which fails if MCP `workspaceRoots` is not configured).
   - Verify injection (`version: "3.0.0"`) and video surface detection:
     ```js
     () => ({
       hasApi: Boolean(window.gameplayApi),
       version: window.gameplayApi?.version,
       frame: window.gameplayApi?.inspectFrame(),
     })
     ```

---

## 2. Pre-Flight Calibration (Before Starting Gameplay)

Before entering real-time action, verify four behaviors using `hideOverlay()` + single JPEG screenshots (`format: "jpeg"`, `quality: 85`, omitting `filePath`):
1. **Menu navigation**: Test whether menus respond to `BTN.DPAD_*` taps (`tapButton(BTN.DPAD_DOWN, 90, 180)`) or analog Left Stick pulses (`await window.gameplayApi.pulseStick(0, x, y)`—e.g. SuperTuxKart's Main Menu ignores `DPAD_*` and requires `pulseStick`).
2. **Pause & Unpause buttons**: Confirm which button opens Pause (usually `BTN.START = 9`) and which resumes (`BTN.A = 0` or `BTN.START = 9`). Runtime v3 automatically snapshots `FINAL MINIMAP` / `FINAL TUTORIAL PROMPT` / `FINAL LOOKAHEAD & ALERT` **before** tapping `BTN.START` so post-pause overlays never hide HUD crops.
3. **Edge-triggered inputs across Pause**: Verify whether holding throttle across unpause works or is ignored until re-pressed *after* the pause dialog closes (handled automatically by `driveServo` and `runChunk` via `unpauseSettleMs: 220`).
4. **Overloaded buttons**: Note buttons whose meaning flips between paused and unpaused states (e.g., in SuperTuxKart `BTN.A` confirms/unpauses in menus, but **looks behind** during live driving).

---

## 3. Two-Loop Control Protocol

### A. System 1 — `driveServo()` (Straights, Moderate Curves & Corridor Tracking)
Use `driveServo` (`v3`) for straights, bridges, tunnels, and moderate bends:
```js
async () => await window.gameplayApi.driveServo({
  maxDurationMs: 2400,
  steerBias: 0,
  label: "seg-corridor",
})
```
- Pass `unpause: false` **only** when the game is already unpaused (such as the initial `Ready!` countdown).
- **Runtime v3 capabilities & remaining boundaries**:
  - **Multi-cue road tracking**: `vision.ts` v3 rejects pale desert sand (`sandPenalty`), vertical plaster/canyon walls (`wallPenalty`), bright glare, grass, and sky; uses a thresholded column centroid (`navThreshold = 0.45`) so shoulders never dilute curve steering; freezes `roadModel` adaptation when off-center or low-confidence; and detects outlined orange-gold `WRONG WAY!` banners (`stopReason = "red_alert"`).
  - **Curvature-coupled throttle modulation**: `driveServo` automatically feathers `BTN.Y` when `|steer| > 0.44` so moderate-tight bends track cleanly.
  - **When to switch to `runChunk`**: Use modest horizons (`1800–2400ms`) approaching blind hill crests or `>= 80°` hairpins, and switch to `runChunk` whenever executing explicit tutorial mechanics (weapon fire, look-behind fire, nitro, drift/skid) or blind 90°+ turns where road pixels are not yet visible ahead.

### B. System 2 — `runChunk()` (90°+ Hairpins, Blind Crests, Mechanics & Shoulder Re-entry)
Use `runChunk` whenever executing `>= 80°` blind turns, firing items, using nitro, skidding/drifting, or steering cleanly back from a road shoulder:
```js
async () => await window.gameplayApi.runChunk(async ({ api }) => {
  // Ease or hold gas while steering/drifting through a sharp corner
  await api.rampStick(0, -0.7, 0, 100);
  api.setButton(api.BTN.RB, 1); // optional drift/skid in STK
  await api.sleep(900);
  api.setButton(api.BTN.RB, 0);
  await api.rampStick(0, 0, 0, 120);
  await api.sleep(350);
}, { holdGasButton: window.gameplayApi.BTN.Y, label: "seg-sharp-left" })
```
- `runChunk` wraps your callback in `try / finally`, snapshotting the unpaused HUD before pausing and calling `resetAll()` even on error.

---

## 4. Reading Contact Sheets & Spatial Orientation Rules

After each `driveServo` or `runChunk`, call `take_screenshot` (`format: "jpeg"`, `quality: 85`) and `read_file`:

1. **Inspect all three pre-pause HUD crops at the bottom of the sheet**:
   - `FINAL MINIMAP` (bottom-left), `FINAL TUTORIAL PROMPT` (bottom-center), and `FINAL LOOKAHEAD & ALERT` (2× zoom of the road horizon, `<<<` / `>>>` wall chevrons, items, and `WRONG WAY!` zone) are captured **before** `BTN.START` pauses the game, so they are always unobstructed.
2. **Check actual motion and `stopReason`, not just `roadConf`**:
   - Red `+Tms Δ0.0%` badges or `stop=stuck` mean the vehicle is stopped or wedged; `stop=low_confidence` means a wall, sand trap, or sharp blind corner lies right ahead—switch to `runChunk` to turn onto the visible road rather than calling `driveServo` straight ahead again!
   - `stop=red_alert` means `WRONG WAY!` appeared—stop and reorient immediately.
3. **Never confuse North-Up Minimap Left/Right with Kart Left/Right**:
   - On a static north-up minimap, **moving downward (south) flips left and right**: a road bending toward the *left* edge of the minimap is a **right turn (`+X`)** from the driver's seat, and a bend toward the *right* edge of the minimap is a **left turn (`-X`)**.
   - Always determine your heading vector from dot movement across tiles first, and **prioritize 3D viewport cues** (`<<<` / `>>>` wall chevrons in `FINAL LOOKAHEAD & ALERT`, road curb tangents) whenever visible.

---

## 5. Recovery Discipline (Do Not Crutch on `smartRescue`)

Treat rescues (`smartRescue()` / `BTN.BACK`) as an **emergency recovery**, not a routine cornering tool:

- **Minor shoulder drift (1–3m off-road, road clearly visible beside you, no wall blocking)**:
  - Recover via `runChunk`: release full throttle briefly or pulse gas while steering `0.4–0.6` back onto the road surface, then counter-steer straight upon re-entry.
- **True stuck / irrecoverable state (wedged against wall/fence, fallen off ledge, `WRONG WAY!`, or backwards)**:
  - Do **not** chain blind multi-point reverse turns. Either back straight out (`BTN.X` with stick `(0, 0)` for `600–800ms`) before steering forward, or call `await window.gameplayApi.smartRescue({ label: "rescue" })`.
- **Track your rescue count**: Report total manual + automatic rescues at the end of a run. A clean playthrough should require **0–1 rescues**; repeated rescues indicate you entered corners too fast or misread turn direction.
