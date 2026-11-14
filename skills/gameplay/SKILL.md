---
name: gameplay
description: >-
  Use this skill when playing or testing unmodified video games streamed in Chrome
  (such as MoonlightWeb, SuperTuxKart, or Xbox Cloud/Remote Play) using virtual
  controller inputs (window.gameplayApi) and rendered video pixels.
---

# Gameplay Agent Skill (Two-Loop Servo + Pretrained 3D Depth & OpenCV)

Play games strictly through rendered video pixels (`<canvas>` / `<video>`) and virtual controller inputs (`window.gameplayApi`)—never modifying game files or reading engine internals.

For game-specific bindings, track hazards, and empirical post-mortems, load on demand:
- **SuperTuxKart controls, pause quirks & tutorial reference**: [references/supertuxkart.md](./references/supertuxkart.md) *(Note: if evaluating zero-shot generalization on an unseen Singleplayer track, use only the general controls/menu section or calibrate from scratch—never use track-specific spoilers).*
- **Cross-game architecture & failure lessons**: [docs/lessons-learned.md](../../docs/lessons-learned.md)

---

## 1. Inject & Verify `window.gameplayApi` (`v4.0.0`)

1. **Find target page**: Call `chrome-devtools` MCP `list_pages` to get `pageId`.
2. **Inject runtime inline** (once per page load):
   - Read `packages/runtime/gameplay-runtime.js` and pass its text inline to `evaluate_script` with `format: "script"` (avoid `sourcePath` in MCP, which fails if `workspaceRoots` is not configured).
   - Verify injection (`version: "4.0.0"`) and video surface detection:
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
2. **Pause & Unpause buttons**: Confirm which button opens Pause (usually `BTN.START = 9`) and which resumes (`BTN.A = 0` or `BTN.START = 9`). Runtime v4 automatically snapshots `FINAL MINIMAP` / `FINAL TUTORIAL PROMPT` / `FINAL LOOKAHEAD & ALERT` **before** tapping `BTN.START` so post-pause overlays never hide HUD crops.
3. **Edge-triggered inputs across Pause**: Verify whether holding throttle across unpause works or is ignored until re-pressed *after* the pause dialog closes (handled automatically by `driveServo` and `runChunk` via `unpauseSettleMs: 220`).
4. **Overloaded buttons**: Note buttons whose meaning flips between paused and unpaused states (e.g., in SuperTuxKart `BTN.A` confirms/unpauses in menus, but **looks behind** during live driving).

---

## 3. Two-Loop Control + Pretrained 3D Depth & OpenCV Perception

### A. System 1 — `driveServo()` (`v4` Biome-Agnostic Pure-Pursuit Servo)
Use `driveServo` (`v4.0.0`) for straights, bridges, tunnels, and moderate bends across **any unseen track biome** (asphalt, cobblestone, dirt, snow/ice, wood, moss):
```js
async () => await window.gameplayApi.driveServo({
  maxDurationMs: 2200,
  steerBias: 0,
  label: "seg-corridor",
})
```
- Pass `unpause: false` **only** when the game is already unpaused (such as the initial `Ready! / Set! / Go!` countdown, which also cleanly resets and seeds the road appearance model on the starting surface).
- **Mid-lap surface transitions (`resetRoadModel`)**: If an unseen track transitions mid-lap to a completely different surface material (e.g. grey asphalt → wooden pier or dark cave) and `driveServo` stops early with `stop=low_confidence` even though the kart is centered on the new road, call `window.gameplayApi.resetRoadModel()` before the next `driveServo` so it re-seeds onto the new surface.
- **Runtime v4 capabilities**:
  - **Biome-agnostic road & contrastive shoulder learning**: Seeds road appearance from flanking wheel patches (including bright snow/ice or mossy tracks), learns an online off-road shoulder prototype on centered straights to repel off-track borders on curves, and uses **mode-seeking contiguous corridor selection** so center obstacles or split forks never average left and right to `0.0`.
  - **Pure-Pursuit dual-band curvature & auto corner braking**: Tracks near (`y=53..59%`) and far (`y=43..48%`) lookahead bands (`meanCurvature`), feathering gas and tapping brief brake pulses on high-speed tight corners.
  - **Keep `steerBias: 0` when `roadConfidence >= 0.65`**, or pass `depthSteerHint` from `bun run perceive` when 3D obstacles/walls or low-contrast transitions are ahead.

### B. Third-Party 3D Depth & OpenCV Analyzer (`bun run perceive`)
Whenever `roadConfidence < 0.50`, `stop=low_confidence`, approaching blind/ambiguous corners, obstacles, forks, or unfamiliar terrain on an unseen track, run the offline perception CLI (**runs in ~400ms inside Standard Sandbox Mode with `BypassSandbox: false`**) on the latest screenshot path returned by `take_screenshot`:
```sh
bun run perceive /path/to/screenshot.jpg
```
- **What `perceive` computes (zero network, local quantized ONNX + OpenCV WASM + `sharp`)**:
  - **`depth3d`** (*Depth Anything V2 Small*): 7-sector 3D clearance profile (`sectorClearanceLtoR`), mode-seeking deepest 3D opening (`corridorOffsetX` in `[-1..+1]`), and `wallOrObstacleAhead` (catches thin posts, trees, crates, and rock walls that fool 2D RGB similarity).
  - **`opencv`** (*`@techstark/opencv-js` 5.0*): Canny + Probabilistic Hough perspective vanishing point (`vanishingPointX`) and Difference-of-Gaussians minimap ribbon tracking (`onRibbon`, `headingDeg`, ego-centric `turnAheadDeg` computed from actual player-marker motion across Tile 1 → Final Minimap!).
  - **`recommendation`**: Actionable `action` (`driveServo`, `driveServo_biased`, `runChunk_turn_left`, `runChunk_turn_right`, or `reverse_and_realign`) + `suggestedSteerBias`. Pass `--out /path/to/scratch/depth.jpg` if you want to visually inspect the 3D disparity heatmap.
- **Feeding `perceive` into `driveServo`**:
  ```js
  async () => await window.gameplayApi.driveServo({
    maxDurationMs: 1800,
    depthSteerHint: 0.28,
    label: "seg-depth-guided",
  })
  ```

### C. System 2 — `runChunk()` (90°+ Hairpins, Blind Crests, Mechanics & Shoulder Re-entry)
Use `runChunk` whenever executing `>= 75°` hairpins, avoiding close center obstacles (`wallOrObstacleAhead: true`), firing items, using nitro, skidding/drifting, or steering cleanly back from a road shoulder:
```js
async () => await window.gameplayApi.runChunk(async ({ api }) => {
  await api.rampStick(0, -0.7, 0, 100);
  api.setButton(api.BTN.RB, 1); // optional drift/skid in STK
  await api.sleep(900);
  api.setButton(api.BTN.RB, 0);
  await api.rampStick(0, 0, 0, 120);
  await api.sleep(350);
}, { holdGasButton: window.gameplayApi.BTN.Y, label: "seg-sharp-left" })
```

---

## 4. Reading Contact Sheets & Spatial Orientation Rules

After each `driveServo` or `runChunk`, call `take_screenshot` (`format: "jpeg"`, `quality: 85`) and `read_file` (plus `bun run perceive <screenshot>` whenever `roadConf < 50%` or geometry looks ambiguous):

1. **Inspect all three pre-pause HUD crops**: `FINAL MINIMAP`, `FINAL TUTORIAL PROMPT` (or lap/timer HUD), and `FINAL LOOKAHEAD & ALERT` (2× horizon zoom).
2. **Never confuse North-Up Minimap Left/Right with Kart Left/Right**:
   - Moving downward (south) on a static minimap **flips left and right**! Use `bun run perceive` (`opencv.minimap.headingDeg` & `turnAheadDeg`) and 3D viewport geometry (`depth3d.corridorOffsetX`, `<<<` / `>>>` wall chevrons, curb tangents) rather than guessing north-up left/right.
3. **Zero-Shot Unseen Track Protocol**:
   - On Segment 1 (`unpause: false` at `Go!`), run a conservative `1600–2000ms` `driveServo` to seed the track's road & shoulder colors cleanly and observe initial lap count / minimap scale.
   - Keep horizons modest (`1600–2200ms`) on Lap 1 of an unseen track because blind hairpins, chicanes, water hazards, or surface changes can appear without warning.

---

## 5. Recovery Discipline (Do Not Crutch on `smartRescue`)

Treat rescues (`smartRescue()` / `BTN.BACK`) as an **emergency recovery**, not a routine cornering tool:

- **Minor shoulder drift or sloped cliff lip (1–3m off-road, road visible beside you, no wall blocking)**:
  - Recover via `runChunk`: ease/pulse gas while steering `0.4–0.6` forward back onto the road surface, then counter-steer straight upon re-entry. **Never hold reverse (`BTN.X`) when perched on a downward outer cliff lip**.
- **True stuck / irrecoverable state (wedged against wall/fence, fallen into water/abyss, `WRONG WAY!`, or backwards)**:
  - Back straight out (`BTN.X` with stick `(0, 0)` for `600–800ms`) before steering forward, or call `await window.gameplayApi.smartRescue({ label: "rescue" })`.
- **Track your rescue count**: Always report total manual + automatic rescues, off-road excursions, and wall-clock lap/completion time at the end of a run.
