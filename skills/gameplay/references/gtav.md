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
   - Always pass `{ gasButton: window.gameplayApi.BTN.RT, unpause: false, pause: false, stopOnRaceFinish: false }` if using `driveServo()`, or drive with `runChunk(..., { unpause: false, pause: false })` holding `BTN.RT`.
2. **Tight-Timer Combat & QTEs (e.g., Prologue Hostage Shot)**:
   - Turn-by-turn `runChunk` -> `take_screenshot` -> `read_file` -> LLM round-trips add ~5–10s per step, exceeding short hostage/QTE windows.
   - Combine `LT` (`BTN.LT = 6`) aim/snap + calibrated Right Stick nudge + `RT` (`BTN.RT = 7`) burst inside a **single `runChunk`** without intermediate screenshot round-trips.
3. **No Checkpoint Skips**:
   - Always choose `Retry [A]` on `Mission Failed` screens rather than `Skip [X]`, so aiming/driving issues are diagnosed and fixed rather than bypassed.
4. **Always `unpause: false, pause: false`**:
   - GTA V is a real-time 3D game; never let `runChunk` or `driveServo` press `BTN.A` before or `BTN.START` after every segment.
5. **Cover-and-Peek Combat (`RB` + `LT`/`RT`)**:
   - In heavy gunfights (e.g., 5-star Prologue shootout), stay in cover (`BTN.RB`) and use short `LT` (aim/snap) + `RT` bursts to clear nearby red minimap blips before advancing to the next cover point. Walking in the open while police vehicles are firing rapidly drains health.
6. **Geometry Snags & Ally-Blip Orientation**:
   - Narrow doorways, guard booths, and fence posts can snag forward movement (`Left Stick y: -1`). If `motionScore` drops or the character hugs a wall/post, rotate the camera (`Right Stick` `x`) toward the road or blue ally blips on the minimap before sprinting (`BTN.A` + `Left Stick y: -1`).
