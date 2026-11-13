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
   - Verify injection and video surface detection:
     ```js
     () => ({
       hasApi: Boolean(window.gameplayApi),
       frame: window.gameplayApi?.inspectFrame(),
     })
     ```

---

## 2. Pre-Flight Calibration (Before Starting Gameplay)

Before entering real-time action, verify four behaviors using `hideOverlay()` + single JPEG screenshots (`format: "jpeg"`, `quality: 85`, omitting `filePath`):
1. **Menu navigation**: Test whether menus respond better to discrete `BTN.DPAD_*` taps (`tapButton(BTN.DPAD_DOWN, 90, 180)`) or short Left Stick pulses (`setStick(0, x, y)` for `120–160ms`, then `(0, 0)`).
2. **Pause & Unpause buttons**: Confirm which button opens Pause (usually `BTN.START = 9`) and which resumes (`BTN.A = 0` or `BTN.START = 9`), and check whether the Pause overlay hides the HUD/minimap.
3. **Edge-triggered inputs across Pause**: Verify whether holding throttle across unpause works or is ignored until re-pressed *after* the pause dialog closes (e.g., SuperTuxKart requires unpausing first, waiting `~220ms`, then pressing gas).
4. **Overloaded buttons**: Note buttons whose meaning flips between paused and unpaused states (e.g., in SuperTuxKart `BTN.A` confirms/unpauses in menus, but **looks behind** during live driving).

---

## 3. Two-Loop Control Protocol

### A. System 1 — `driveServo()` (Straights & Gentle Visible Curves Only)
Use `driveServo` for clean straights and mild bends where road contrast is clear:
```js
async () => await window.gameplayApi.driveServo({
  maxDurationMs: 2200,
  steerBias: 0,
  label: "seg-straight",
})
```
- Pass `unpause: false` **only** when the game is already unpaused (such as the initial `Ready!` countdown).
- **Current `driveServo` limitations to respect** (until `vision.ts` v3 lands):
  - **Low-contrast terrain trap**: On desert/canyon tracks where sand shoulders or beige rock walls share warm luminance with dirt roads, `avgRoadConfidence` can read `85–97%` even while drifting off-road, and column-centroid dilution keeps steering gentle (`|meanSteerX| < 0.2`).
  - **Full-throttle understeer**: `driveServo` holds full throttle (`BTN.Y = 1`), which cannot make `>= 60°` hairpins without running wide.
  - **Mitigation**: Keep `maxDurationMs` modest (`1800–2500ms`) when approaching bends or blind crests, and **switch to `runChunk` *before* sharp corners** rather than waiting for `driveServo` to run off-track.

### B. System 2 — `runChunk()` (Sharp Corners, Blind Crests, Mechanics & Recoveries)
Use `runChunk` whenever executing `>= 60°` turns (modulating gas or drifting), firing items, using nitro, cresting blind hills, or rejoining the road from a shoulder:
```js
async () => await window.gameplayApi.runChunk(async ({ api }) => {
  // Ease gas briefly or engage drift to tighten turn radius on sharp corners
  await api.rampStick(0, -0.7, 0, 100);
  api.setButton(api.BTN.RB, 1); // optional drift/skid in STK
  await api.sleep(900);
  api.setButton(api.BTN.RB, 0);
  await api.rampStick(0, 0, 0, 120);
  await api.sleep(350);
}, { holdGasButton: window.gameplayApi.BTN.Y, label: "seg-sharp-left" })
```
- `runChunk` wraps your callback in `try / finally`, guaranteeing pause + `resetAll()` even on error.

---

## 4. Reading Contact Sheets & Spatial Orientation Rules

After each `driveServo` or `runChunk`, call `take_screenshot` (`format: "jpeg"`, `quality: 85`) and `read_file`:

1. **Check actual motion, not just `roadConf`**:
   - Red `+Tms Δ0.0%` badges or `stop=stuck` mean the vehicle is stopped or wedged even if `roadConf > 90%`.
2. **Watch for post-pause HUD occlusion**:
   - If the game hides its minimap when paused (e.g., SuperTuxKart replaces `FINAL MINIMAP` with `Exit Race`), read the minimap inside the **last active tile** (`tile 7` / `tile 8` in the 4×2 grid), not the post-pause bottom-left crop.
3. **Never confuse North-Up Minimap Left/Right with Kart Left/Right**:
   - On a static north-up minimap, **moving downward (south) flips left and right**: a road bending toward the *left* edge of the minimap is a **right turn (`+X`)** from the driver's seat, and a bend toward the *right* edge of the minimap is a **left turn (`-X`)**.
   - Always determine your heading vector from dot movement across tiles first, and **prioritize 3D viewport cues** (`<<<` / `>>>` wall chevrons, road curb tangents) whenever visible.

---

## 5. Recovery Discipline (Do Not Crutch on `smartRescue`)

Treat rescues (`smartRescue()` / `BTN.BACK`) as an **emergency recovery**, not a routine cornering tool:

- **Minor shoulder drift (1–3m off-road, road clearly visible beside you, no wall blocking)**:
  - Recover via `runChunk`: release full throttle briefly or pulse gas while steering `0.4–0.6` back onto the road surface, then counter-steer straight upon re-entry.
- **True stuck / irrecoverable state (wedged against wall/fence, fallen off ledge, `WRONG WAY!`, or backwards)**:
  - Do **not** chain blind multi-point reverse turns. Either back straight out (`BTN.X` with stick `(0, 0)` for `600–800ms`) before steering forward, or call `await window.gameplayApi.smartRescue({ label: "rescue" })`.
- **Track your rescue count**: Report total manual + automatic rescues at the end of a run. A clean playthrough should require **0–1 rescues**; repeated rescues indicate you entered corners too fast or misread turn direction.
