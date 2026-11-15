# Grand Theft Auto V (MoonlightWeb / Xbox Layout) Reference

Empirical notes and control bindings for playing unmodified *Grand Theft Auto V* over MoonlightWeb (`https://jane.local/`) using `window.gameplayApi` (`v5.0.1`).

## 1. Xbox Controller Layout (`window.gameplayApi.BTN`)

| Action | On Foot | In Vehicle | Menus / Phone |
| :--- | :--- | :--- | :--- |
| **Left Stick (`0` / `'left'`)** | Move (`y: -1` forward) | Steer (`x: -1` left, `+1` right) | Navigate |
| **Right Stick (`1` / `'right'`)** | Camera / Free-aim | Camera | — |
| **`BTN.RT` (`7`)** | Fire weapon | **Accelerate (Gas)** | — |
| **`BTN.LT` (`6`)** | Aim / Auto-aim snap | Brake / Reverse | — |
| **`BTN.RB` (`5`)** | Take cover | Handbrake | — |
| **`BTN.LB` (`4`)** | Weapon wheel (hold) | Aim / Fire from vehicle | — |
| **`BTN.A` (`0`)** | Sprint (hold/tap) | Duck / Handbrake (alt) | Confirm / Retry / Phone Select |
| **`BTN.B` (`1`)** | Reload / Melee | Cinematic camera | Back / Hang up |
| **`BTN.X` (`2`)** | Jump / Climb | Switch weapon / Radio | *(Avoid `Skip` on Mission Failed)* |
| **`BTN.Y` (`3`)** | **Enter / Exit vehicle** | **Exit vehicle** | Restart mission |
| **`BTN.START` (`9`)** | Pause / Unpause | Pause / Unpause | Resume |
| **`BTN.DPAD_DOWN` (`13`)** | Expand minimap / Character switch | Expand minimap | — |

## 2. Critical Traps & Invariants

1. **Never call `driveServo()` with default `gasButton` in GTA V**:
   - `driveServo()` defaults `gasButton` to `BTN.Y` (SuperTuxKart's accelerate button), which **jumps out of the vehicle** in GTA V.
   - Always use `window.gameplayApi.gtavDrive(options)` (which wraps `driveServo()` with `{ gasButton: BTN.RT, unpause: false, pause: false, stopOnRaceFinish: false }`), or pass those explicit flags if calling `driveServo()` directly.
2. **Tight-Timer Combat & Precision Hostage/Headshot Checks (e.g., Prologue Hostage Shot)**:
   - Turn-by-turn `runChunk` -> `take_screenshot` -> `read_file` -> LLM round-trips add ~5–25s per step, exceeding short hostage/QTE windows.
   - Chain `waitForRadar` -> `switchCharacter` -> `autoCombatSweep` / `autoPan` inside a **single `evaluate_script` call** without intermediate screenshot gaps.
   - Because WebCodecs 4:2:0 chroma subsampling or scripted red lighting can wash out GTA V's ~2×2px reticle dot (leaving `readGtavReticle().state` `"neutral"`/`"none"`), use a **hybrid check** for friendly-hostage standoffs: pre-center with `autoPan`, hold `LT` on target, capture **one clean `1280×720` JPEG** (`showSheetOverlay: false`) to visually confirm crosshairs are on the hostile (not the friendly hostage, where GTA V blocks `RT`), then fire `RT` and release `LT`/`RT`.
3. **No Checkpoint Skips**:
   - Always choose `Retry [A]` on `Mission Failed` screens rather than `Skip [X]`, so aiming/driving issues are diagnosed and fixed rather than bypassed.
4. **Pause Semantics (`unpause: false, pause: false` Default vs. Strategic `BTN.START` Freeze in Story Mode)**:
   - ***GTA V* Story Mode IS pausable via `BTN.START` (`9`)** (unlike *GTA Online*).
   - All GTA V runtime helpers default to `unpause: false, pause: false` (never use `runChunk`/`driveServo` defaults here) because `BTN.START` opens an **opaque full-screen Pause Menu (`MAP | BRIEF | ...`)** that hides 100% of the live `1280×720` gameplay frame, default `unpauseButton: BTN.A` clicks into **`MAP`** instead of resuming (`BTN.START` resumes), and pausing drops held `LT` aim-down-sights locks while adding ~1s menu fade transitions.
   - However, if you want **zero turn-gap exposure in Story Mode** while thinking through a complex shot/route, take your clean `1280×720` `take_screenshot` **first**, tap `BTN.START` (`tapButton(BTN.START, 90, 200)`) to pause while planning, then tap `BTN.START` (never `BTN.A`) to resume right before the next action (or pass `{ unpause: true, unpauseButton: BTN.START, pause: true, pauseButton: BTN.START, showSheetOverlay: true }`).
5. **Cover-and-Peek Combat (`RB` + `LT`/`RT`)**:
   - In heavy gunfights (e.g., 5-star Prologue shootout), **never leave the character exposed during the 5–10s LLM screenshot/thinking gap** between `runChunk` calls:
     1. End movement chunks near a pillar/crate/car with `api.tapButton(api.BTN.RB, 80, 120)` to snap into cover before inspecting the screenshot.
     2. In peek-fire chunks, hold `LT` (peek + auto-aim) + `RT` bursts, then **release `LT` and `RT` before the chunk ends** so the character ducks back behind cover while you think.
     3. Use `BTN.L3` (`10`) + `BTN.R3` (`11`) together for Trevor's Special Ability (temporary damage reduction) when crossing open ground.
6. **Geometry Snags & Ally-Blip Orientation**:
   - Narrow doorways, guard booths, and fence posts can snag forward movement (`Left Stick y: -1`). If `motionScore` drops or the character hugs a wall/post, use `navigateToObjective()` (which includes doorway `unstickStrafe`) or rotate the camera (`Right Stick` `x`) toward the road or blue ally blips on the minimap before sprinting (`BTN.A` + `Left Stick y: -1`).
7. **Unobstructed `1280×780` (`16:9`) Viewport & `showSheetOverlay: false`**:
   - Resize the MoonlightWeb Chrome tab to **`1280×780` (`16:9`)** upfront (`resize_page`) so the streamed `1280×720` canvas is never squished.
   - Keep `showSheetOverlay: false` in real-time combat (default on `coverPeekBurst`, `autoCombatSweep`, `navigateToObjective`, `gtavDrive`, and `switchCharacter`; pass `{ showSheetOverlay: false }` explicitly on `sprintMove` / `runChunk` and clear any ad-hoc overlay via `hideOverlay()`). Rendering 4×2 contact sheets over live gameplay occludes aiming and induces slow 15–25s tile-inspection pauses under fire.
8. **Infinite-Respawn Advancing Shootouts (e.g., `"Escape the Cops"`)**:
   - Police spawn endlessly in advancing escape sequences until the player pushes past forward mission triggers alongside NPC allies (`Michael` / `Brad`).
   - Do **not** camp at the starting pillar waiting for `enemyPixels === 0` (`autoCombatSweep`'s `stopWhenClear` is for finite rooms—use `maxCycles: 1–2` between pushes instead).
   - Never take exposed center-lot police car cover (`RB` behind vehicles in the middle of the yard risks accidental car hood-vaulting into bullets or getting flanked from the guard booth). Fire `1–2` quick bursts to drop immediate close rushers, trigger `activateSpecial()` (`L3+R3`), and chain `sprintMove({ endCover: true, showSheetOverlay: false })` from **side-wall hard cover to hard cover** (`right pillar → right wall electrical box → exit gate`) without stopping mid-road for screenshots.

## 3. Closed-Loop GTA V Runtime Helpers (`window.gameplayApi`)

Always prefer these in-page closed-loop helpers (added across `2b71837`..`2924ad7`) over open-loop `setStick`/`sleep` sequences so the character reacts within `<200ms` and never sits exposed during LLM turn gaps (`showSheetOverlay: false` by default on `coverPeekBurst`, `autoCombatSweep`, `navigateToObjective`, `gtavDrive`, and `switchCharacter`):

1. **`window.gameplayApi.readGtavRadar()`**:
   - Crops the bottom-left minimap (`[0..0.20, 0.76..1.0]` at `128×96`) and returns `{ radarVisible, healthPct, lowHealth, enemyPixels, enemiesAhead, enemiesLeft, enemiesRight, enemiesBehind, closestEnemyDist, enemyAngleDeg, objectiveVisible, objectiveColor, objectiveAngleDeg, objectiveDist, objectivePixels, gpsSteerBias }`.
   - Guards `lowHealth` against cutscene hidden HUDs (`healthBarVisible`: `healthPct > 0.03 || redBarRatio > 0.15`) and flashing red alarm hallways (`healthPct < 0.45`). Call before sprinting out of cover so flanking threats are cleared first, or to read inverse-distance-weighted `enemyAngleDeg` / `objectiveAngleDeg` (`0°` ahead, `+90°` right, `-90°` left; note `±12°` quantization at ~2m).
2. **`window.gameplayApi.navigateToObjective(options?)`**:
   - Closed-loop ~15 Hz on-foot navigation toward the minimap objective blip (`yellow`/`green`/`blue`): continuously yaws `Right Stick` toward `objectiveAngleDeg`, sprints forward (`BTN.A` + `Left Stick y: -1`), pauses forward motion while spinning if `|objectiveAngleDeg| > 105°`, strafes briefly if snagged on a doorway (`unstickStrafe: true`), and stops early with `stopReason` `"reached_objective"` (`objectiveDist <= stopDist`), `"enemy_detected"` (`stopOnEnemy: true`, `enemyThreshold: 6`), or `"low_health"` (after triggering `L3+R3` Special if `autoSpecialOnLowHealth: true`).
3. **`window.gameplayApi.autoCombatSweep(options?)`**:
   - Closed-loop multi-cycle cover peek-fire (`LT` lock-on + `RT` burst + duck pause) with `maxCycles`, `maxDurationMs`, `aimSettleMs`, `burstMs`, `duckMs`, `enterCover`, `special`, `autoSpecialOnLowHealth`, `autoPan`, `panMs`, `panDeadbandDeg` (default `8°`), `verifyReticle` (default `true`), `requireEnemyReticle` (default `false`: set `true` for precision/hostage shots when reticle color is strong enough to read red vs. friendly), `reticleScanMs` (default `900ms`), and `stopWhenClear` (default `true`: stops early after 2 consecutive zero-enemy radar checks once enemies were engaged).
   - Checks `readGtavRadar()` before each burst and every `120ms` during the `reticleScanMs` peek: if `|enemyAngleDeg| > panDeadbandDeg` (or `enemiesAhead === 0`) and `autoPan: true` (default), pans `Right Stick` in damped pulse-and-settle steps until `|enemyAngleDeg| <= panDeadbandDeg` before pressing `LT`; then checks `readGtavReticle()` while holding `LT` (`verifyReticle: true`) in `requestAnimationFrame`-synced steps until the reticle turns red (`"enemy"`), skipping `RT` if the reticle is over a friendly NPC (`"friendly"`). If `lowHealth` occurs before or mid-peek (`120ms` poll), immediately releases `LT` back into cover and triggers `L3 + R3` Special (if `autoSpecialOnLowHealth: true`), and always releases `LT`/`RT` before returning.
4. **`window.gameplayApi.activateSpecial(options?)`**:
   - Presses `L3 + R3` simultaneously (`{ holdMs: 90, settleMs: 60 }`) to activate the active character's Special Ability (Trevor's rage/damage reduction, Michael's slow-mo, Franklin's driving focus) and returns `readGtavRadar()`. Call before pushing across open ground under heavy fire!
5. **`window.gameplayApi.readGtavReticle()`**:
   - Samples the center reticle patch (`32×32` scaled from center `2.5%×3.5%` video box) and returns `{ state: "enemy" | "friendly" | "neutral" | "none", redPixels, greenPixels, whitePixels }`. Useful to guard against friendly locks (`"friendly"` / green); under WebCodecs 4:2:0 subsampling or dark red lighting, the 2×2px dot can wash out to `"neutral"`/`"none"`, so verify visually on a clean `1280×720` frame before shooting critical hostages.
6. **`window.gameplayApi.sprintMove(options?)`**:
   - Pre-move camera yaw (`yawX`, `yawY`, `yawMs`) + `BTN.A` sprint (`moveX`, `moveY`, `durationMs`) with `shouldAbort()` wall-snag early stop and optional `endCover: true` (`RB` snap at destination; pass `showSheetOverlay: false` in live combat).
   - Supports `special: true` (`L3 + R3` before sprinting) and checks `readGtavRadar()` every `150ms` mid-sprint (`abortOnLowHealth: true`, `autoSpecialOnLowHealth: true` by default): if health drops to red mid-sprint, triggers Rage (`L3+R3`) if unused or aborts early and snaps into cover (`RB`).
7. **`window.gameplayApi.coverPeekBurst(options?)`**:
   - Single-exchange cover-safe `LT` aim + optional Right Stick nudge (`aimX`, `aimY`, `aimNudgeMs`) + `RT` bursts + optional `special: true`, guaranteed to release `LT` and `RT` before returning.
8. **`window.gameplayApi.gtavDrive(options?)`**:
   - Safe GTA V vehicle wrapper around `driveServo()` defaulting `{ gasButton: BTN.RT, unpause: false, pause: false, stopOnRaceFinish: false, showSheetOverlay: false, useRadarGps: true, radarGpsWeight: 0.35 }` so `BTN.Y` (exit vehicle) is never pressed and minimap GPS/objective steering bias is blended into road-following.
9. **`window.gameplayApi.switchCharacter(options?)`**:
   - Atomic character-wheel switch: holds `BTN.DPAD_DOWN`, deflects `Right Stick` (`dirX`, `dirY`, default `{ dirX: 1, dirY: 0, holdMs: 550 }`), and releases `BTN.DPAD_DOWN` *before* resetting `Right Stick` so the selection registers reliably.
10. **`window.gameplayApi.waitForRadar(options?)`**:
    - Polls `readGtavRadar()` every `pollMs` (default `100ms`, `timeoutMs: 10000`) until `radarVisible === visible` (default `true`), eliminating blind `sleep(...)` guesswork after cutscenes or mission retries.
11. **`window.gameplayApi.retryMission(options?)`**:
    - Atomic `BTN.A` Retry (never `BTN.X` Skip) + `waitForRadar({ visible: true, timeoutMs: 15000 })` in one call, returning `{ ok, radarVisible, elapsedMs, radar }` on the first active frame after checkpoint reload so timed sequences never lose seconds to a post-retry screenshot gap.
12. **`window.gameplayApi.getRecentHistory()`**:
    - Returns the last 12 chunk telemetry entries (`timestamp`, `label`, `stopReason`, `durationMs`, `avgMotion`, `stuckDetected`, `ok`) for quick post-mortem checks without video encoding.
