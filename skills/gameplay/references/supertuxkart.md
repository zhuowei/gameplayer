# SuperTuxKart Streaming Runbook & Tutorial Guide

Reference for playing unmodified SuperTuxKart streamed over MoonlightWeb (`https://jane.local/`) via `window.gameplayApi`.

## 1. Standard Gamepad Mapping (Xbox Layout → SuperTuxKart)

| `gameplayApi.BTN` | Index | In-Race Action | Menu / Pause Action | Critical Quirks |
| :--- | :---: | :--- | :--- | :--- |
| `BTN.A` | `0` | **Look Behind** (180° rear camera) | **Confirm / Select / Unpause** | **Dual-role hazard**: Tapping `A` when *not* paused flips camera backward! |
| `BTN.B` | `1` | **Fire / Use Item** | Back / Cancel | Fires forward normally; fires backward while holding `BTN.A`. |
| `BTN.X` | `2` | **Brake / Reverse** | — | Steering while reversing rotates nose opposite to forward driving; reverse straight `(0, 0)` first. |
| `BTN.Y` | `3` | **Accelerate (Gas)** | — | **Ignored across Pause dismissal**: Must be pressed *after* `BTN.A` unpauses (`>= 220ms` settle). |
| `BTN.LB` | `4` | **Nitro Boost** | — | Requires collected blue nitro energy in bottom-right gauge. |
| `BTN.RB` | `5` | **Skid / Drift** | — | Requires simultaneous Left Stick steering (`|x| >= 0.45`) while moving; holding too long spins out. |
| `BTN.BACK` | `8` | **Rescue (Lakitu Bird)** | — | Lifts kart for ~1.4s and drops on centerline; `smartRescue()` wraps this cleanly. |
| `BTN.START` | `9` | **Open Pause Dialog** | — | Hides live HUD while paused (`runtime` v3 snapshots crops *before* `START`). |
| Left Stick (`axis 0, 1`) | — | **Steer Left (`-x`) / Right (`+x`)** | **Navigate UI tiles (`pulseStick`)** | **Main Menu requires Left Stick** (`pulseStick`), NOT `DPAD_*`! |
| `BTN.DPAD_*` | `12–15` | — | Ignored on Main Menu | Do **not** rely on `DPAD_*` on STK's Main Menu; use `pulseStick(0, x, y)`. |

---

## 2. Reaching the Tutorial From Main Menu (Exact Verified Path)

1. Call `window.gameplayApi.hideOverlay()` and take a JPEG screenshot (`quality: 85`) to inspect the current Main Menu highlight.
2. **Important**: SuperTuxKart's Main Menu **ignores `BTN.DPAD_*`**! Always use `await window.gameplayApi.pulseStick(0, x, y)` (`y = +1` moves down, `x = -1` moves left, `x = +1` moves right).
3. From the middle row of main cards (`Singleplayer` / `Online` / `Splitscreen` / `Story Mode`):
   - Call `await window.gameplayApi.pulseStick(0, 0, 1)` once to move highlight down onto the **bottom yellow icon bar**.
   - On the bottom yellow icon bar, the **3rd icon from the left** (Tux reading a blue book, right of `?` Help and left of the gold crown) displays the tooltip **`Tutorial`** when focused! Use `pulseStick(0, -1, 0)` or `pulseStick(0, 1, 0)` + screenshot check until the **`Tutorial`** tooltip appears above the book icon.
   - Call `await window.gameplayApi.tapButton(window.gameplayApi.BTN.A, 120, 400)` to launch the Tutorial directly!
4. Wait ~1.5–2.5s (via `sleep`) and take a screenshot until the Hacienda starting grid appears (`Ready!` / `Set!` / `Go!`). Because the game starts **unpaused**:
   - Start Segment 1 with **`unpause: false`** (`driveServo({ maxDurationMs: 2400, unpause: false, label: "seg-1-start" })`).
   - All subsequent segments start from the `Paused` screen and use the default `unpause: true, pause: true`.

---

## 3. Tutorial Track Walkthrough (Hacienda-Style Circuit)

Each prompt appears in the **bottom-center banner** (`y: 0.80..0.99`):

1. **Courtyard Start & Banana Dodge (`"Accelerate with <Y>..."` → `"Avoid bananas!"`)**
   - Straight through the adobe starting arch onto a cobblestone road with green bananas scattered ahead before a **90° right turn**.
   - Pass bananas on the clear left lane (`steerBias: -0.2`), then **use `runChunk` (not full-throttle `driveServo`) to make the 90° right turn** (`+0.65` stick for ~900ms, easing gas briefly if fast) onto the eastbound cobblestone straight.
2. **Gift Boxes & Wooden Crate Tunnel (`"Collect gift boxes, and fire the weapon with <B>..."`)**
   - Line up centered with the row of blue gift boxes before the courtyard archway (`driveServo` can drift onto left sand here if started off-center—keep Tux centered on the dark grey stone).
   - Collect the gift boxes (grants bowling balls) and tap `BTN.B` 2–3 times while driving straight down the covered tunnel to blast a gap through the wooden crate barrier.
3. **Backward Weapon Fire (`"Press <A> to look behind. Fire the weapon with <B> while pressing <A>..."`)**
   - Pick up another gift box past the crates. On the straight dirt road approaching the wooden overpass, run a `runChunk` that holds `BTN.A` (`1`), waits `250ms`, taps `BTN.B`, and immediately releases `BTN.A` (`0`) so normal forward camera restores before the curve.
4. **Overpass Loop, Nitro Collection & Narrow Wooden Bridge (`"Collect nitro bottles..."`)**
   - Pass *under* the wooden bridge into a sweeping **270° left-hand loop** lined with blue nitro bottles.
   - Use moderate left steering (`runChunk` or `driveServo` with gentle `-0.1` bias in `2000ms` steps)—do **not** hug `-0.2` too early (drops off inside ledge) or run full-throttle straight off the outer loop sand.
   - The loop climbs up *onto* the **narrow wooden bridge** (no guardrails!). Center carefully before climbing onto the planks and drive straight across (`steerBias: 0`, `maxDurationMs: 2200`).
5. **Nitro Boost & Blind Windmill Crest (`"Use the nitro you collected by pressing <Left shoulder>!"`)**
   - After exiting the wooden bridge onto the dirt road, hold `BTN.LB` for `~1200ms` with slight left curve alignment to clear the nitro prompt.
   - **Map-inversion & crest hazard**: Approaching the hill crest (windmills ahead), you are heading **south** on the north-up minimap. The road bends slightly **left** approaching the crest, then makes a **sharp corner at the canyon wall** marked by **yellow `<<<` chevron signs** (turning **left** into the canyon). Stop just before/at the crest (`maxDurationMs: 1800`) and read the 3D `<<<` chevrons directly rather than guessing from a south-facing minimap.
6. **Canyon Drift / Skid (`"...skid for several seconds, you will receive a bonus speedup..."`)**
   - Inside the beige rock canyon, the road bends left and then enters a long **sweeping right curve**.
   - Execute the skid prompt here via `runChunk`: steer right (`+0.55`), hold `BTN.RB` for `~1200–1400ms`, release `BTN.RB`, and counter-steer straight (`0`) before the canyon exit (`vision.ts` v3 rejects vertical canyon rock walls via `wallPenalty`, stopping with `low_confidence` if pointed directly at rock).
7. **Final Left Hairpin & True Finish Line (`"You are now ready to race. Good luck!"`)**
   - Exiting the canyon, a white wall with **`<<<` left-pointing chevrons** directs a **left turn** toward a decorative checkered banner and then back onto the cobblestone approach to the **starting adobe arch**.
   - **Finish-line trap**: Passing under the first checkered flag banner (`"You are now ready to race. Good luck!"`) is **not** the end of the tutorial! You must steer right onto the cobblestone road and cross the **red/checkered start/finish line underneath the adobe starting arch** (the red tick mark on the minimap), which automatically exits back to the SuperTuxKart Main Menu.
