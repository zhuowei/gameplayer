# Grand Theft Auto V (MoonlightWeb / Xbox Layout) Reference

Empirical notes and control bindings for playing unmodified *Grand Theft Auto V* over MoonlightWeb (`https://jane.local/`) using `window.gameplayApi` (`v5.0.1`).

## 1. Xbox Controller Layout (`window.gameplayApi.BTN`)

| Action | On Foot | In Vehicle | Menus / Phone |
| :--- | :--- | :--- | :--- |
| **Left Stick (`0`)** | Move (`y: -1` forward) | Steer (`x: -1` left, `+1` right) | Navigate |
| **Right Stick (`1`)** | Camera / Free-aim | Camera | — |
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
2. **Tight-Timer Combat & QTEs (e.g., Prologue Hostage Shot)**:
   - Turn-by-turn `runChunk` -> `take_screenshot` -> `read_file` -> LLM round-trips add ~5–10s per step, exceeding short hostage/QTE windows.
   - Combine `LT` (`BTN.LT = 6`) aim/snap + calibrated Right Stick nudge + `RT` (`BTN.RT = 7`) burst inside a **single `runChunk`** without intermediate screenshot round-trips.
3. **No Checkpoint Skips**:
   - Always choose `Retry [A]` on `Mission Failed` screens rather than `Skip [X]`, so aiming/driving issues are diagnosed and fixed rather than bypassed.
4. **Always `unpause: false, pause: false`**:
   - GTA V is a real-time 3D game; never let `runChunk` or `driveServo` press `BTN.A` before or `BTN.START` after every segment.
5. **Cover-and-Peek Combat (`RB` + `LT`/`RT`)**:
   - In heavy gunfights (e.g., 5-star Prologue shootout), **never leave the character exposed during the 5–10s LLM screenshot/thinking gap** between `runChunk` calls:
     1. End movement chunks near a pillar/crate/car with `api.tapButton(api.BTN.RB, 80, 120)` to snap into cover before inspecting the screenshot.
     2. In peek-fire chunks, hold `LT` (peek + auto-aim) + `RT` bursts, then **release `LT` and `RT` before the chunk ends** so the character ducks back behind cover while you think.
     3. Use `BTN.L3` (`10`) + `BTN.R3` (`11`) together for Trevor's Special Ability (temporary damage reduction) when crossing open ground.
6. **Geometry Snags & Ally-Blip Orientation**:
   - Narrow doorways, guard booths, and fence posts can snag forward movement (`Left Stick y: -1`). If `motionScore` drops or the character hugs a wall/post, rotate the camera (`Right Stick` `x`) toward the road or blue ally blips on the minimap before sprinting (`BTN.A` + `Left Stick y: -1`).

## 3. Closed-Loop GTA V Runtime Helpers (`window.gameplayApi`)

Always prefer these in-page closed-loop helpers (added in `2b71837`, `44b2e74`, `18fbd6d`, and `513e8a1`) over open-loop `setStick`/`sleep` sequences so the character reacts within `<200ms` and never sits exposed during LLM turn gaps:

1. **`window.gameplayApi.readGtavRadar()`**:
   - Crops the bottom-left minimap (`[0..0.20, 0.76..1.0]` at `128×96`) and returns `{ radarVisible, healthPct, lowHealth, enemyPixels, enemiesAhead, enemiesLeft, enemiesRight, enemiesBehind, closestEnemyDist, objectiveVisible, objectiveColor, objectiveAngleDeg, objectiveDist, objectivePixels, gpsSteerBias }`.
   - Call before sprinting out of cover so flanking cops (`enemiesLeft` / `enemiesRight`) are cleared first, or to inspect `objectiveAngleDeg` (`0°` ahead, `+90°` right, `-90°` left) and `objectiveDist`.
2. **`window.gameplayApi.navigateToObjective(options?)`**:
   - Closed-loop ~15 Hz on-foot navigation toward the minimap objective blip (`yellow`/`green`/`blue`): continuously yaws `Right Stick` toward `objectiveAngleDeg`, sprints forward (`BTN.A` + `Left Stick y: -1`), pauses forward motion while spinning if `|objectiveAngleDeg| > 105°`, strafes briefly if snagged on a doorway (`unstickStrafe: true`), and stops early with `stopReason` `"reached_objective"` (`objectiveDist <= stopDist`), `"enemy_detected"` (`stopOnEnemy: true`, `enemyThreshold: 6`), or `"low_health"` (after triggering `L3+R3` Special if `autoSpecialOnLowHealth: true`).
3. **`window.gameplayApi.autoCombatSweep(options?)`**:
   - Closed-loop multi-cycle cover peek-fire (`LT` lock-on + `RT` burst + duck pause) with `maxCycles`, `maxDurationMs`, `aimSettleMs`, `burstMs`, `duckMs`, `enterCover`, `special`, `autoSpecialOnLowHealth`, `autoPan`, `panMs`, and `stopWhenClear` (default `true`: stops early after 2 consecutive zero-enemy radar checks once enemies were engaged).
   - Checks `readGtavRadar()` before each burst: if `enemiesAhead === 0` and `autoPan: true` (default), pans `Right Stick` (`panMs: 180` default) toward `enemiesLeft` / `enemiesRight` / `enemiesBehind` before pressing `LT`; triggers `L3 + R3` Special on `lowHealth` (or aborts into cover), and always releases `LT`/`RT` before returning so the character stays safely behind cover while the LLM inspects the screenshot.
4. **`window.gameplayApi.sprintMove(options?)`**:
   - Pre-move camera yaw (`yawX`, `yawY`, `yawMs`) + `BTN.A` sprint (`moveX`, `moveY`, `durationMs`) with `shouldAbort()` wall-snag early stop and optional `endCover: true` (`RB` snap at destination).
   - Supports `special: true` (`L3 + R3` before sprinting) and checks `readGtavRadar()` every `150ms` mid-sprint (`abortOnLowHealth: true`, `autoSpecialOnLowHealth: true` by default): if health drops to red mid-sprint, triggers Rage (`L3+R3`) if unused or aborts early and snaps into cover (`RB`).
5. **`window.gameplayApi.coverPeekBurst(options?)`**:
   - Single-exchange cover-safe `LT` aim + optional Right Stick nudge (`aimX`, `aimY`, `aimNudgeMs`) + `RT` bursts + optional `special: true`, guaranteed to release `LT` and `RT` before returning.
6. **`window.gameplayApi.gtavDrive(options?)`**:
   - Safe GTA V vehicle wrapper around `driveServo()` defaulting `{ gasButton: BTN.RT, unpause: false, pause: false, stopOnRaceFinish: false, useRadarGps: true, radarGpsWeight: 0.35 }` so `BTN.Y` (exit vehicle) is never pressed and minimap GPS/objective steering bias is blended into road-following.
7. **`window.gameplayApi.switchCharacter(options?)`**:
   - Atomic character-wheel switch: holds `BTN.DPAD_DOWN`, deflects `Right Stick` (`dirX`, `dirY`, default `{ dirX: 1, dirY: 0, holdMs: 550 }`), and releases `BTN.DPAD_DOWN` *before* resetting `Right Stick` so the selection registers reliably.
8. **`window.gameplayApi.waitForRadar(options?)`**:
   - Polls `readGtavRadar()` every `pollMs` (default `100ms`, `timeoutMs: 10000`) until `radarVisible === visible` (default `true`), eliminating blind `sleep(...)` guesswork after cutscenes or mission retries.
9. **`window.gameplayApi.getRecentHistory()`**:
   - Returns the last 12 chunk telemetry entries (`timestamp`, `label`, `stopReason`, `durationMs`, `avgMotion`, `stuckDetected`, `ok`) for quick post-mortem checks without video encoding.
