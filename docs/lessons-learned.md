# Gameplay Agent Lessons Learned & Generalization Guide

Empirical findings from four end-to-end attempts to complete **SuperTuxKart's Tutorial** under strict black-box constraints (**video output + virtual controller input only; zero game modifications**), validating iterative upgrades from raw screenshots to **Runtime v3 (`window.gameplayApi` `3.0.0`)**, along with an honest assessment of what generalizes to future runs and other real-time games.

---

## 1. Quantitative Comparison Across Four Runs

| Dimension | Run 1 (`43531a3d`) | Run 2 (`c0c05158`) | Run 3 (`2d0bd4ea` — Runtime v2) | Run 4 (`d19b18cf` — Runtime v3) |
| :--- | :--- | :--- | :--- | :--- |
| **Control & Observation** | Unpaused open-loop pulses + 1 static PNG | Pause-bounded scripts + `screencast` + `ffmpeg` 8× MP4 | Pause-bounded 30 Hz `driveServo` v2 + post-pause 4×2 JPEG sheet | **30 Hz multi-cue `driveServo` v3 (sand/wall rejection + throttle mod) + pre-pause 4×2 JPEG sheet** |
| **Menu → Grid Time** | ~19m (setup/input failures) | ~8m | ~3m (`DPAD` trial-and-error) | **2m 37s** (1 `pulseStick` + 1 `BTN.A`) |
| **Total Wall-Clock Time** | ~55m (~36.5m driving) | ~5h 18m (~5h 10m driving) | **~46m** (42m 58s driving) | **~1h 47m active** (+10m API timeout, +1m model switch; ~20s/turn VLM reasoning) |
| **Trajectory Steps** | 819 steps | 918 steps (2 compactions) | 494 steps (0 compactions) | **348 steps (0 compactions, −30% vs Run 3)** |
| **Driving Segments** | ~110 pulses | 137 video chunks | 60 segments | **49 live segments (−18% vs Run 3)** |
| **Mechanics Completed** | Partial (skipped 2) | **All** | **All** | **All** |
| **Off-Road Excursions** | Frequent | Frequent (10–23 step reverse loops) | ~15 deep crashes onto sand/walls | **8 total (6 shallow shoulder grazes self-recovered on-road)** |
| **Total Rescues Used** | 3 manual rescues | Late adoption after long reverse loops | 13 total (`9` `smartRescue` + `4` Lakitu) | **2 total (`1` `smartRescue` + `1` Lakitu, −85% vs Run 3)** |
| **State Desyncs** | 9m stream hang | Unpaused + latched brake after error | **0** | **0** (survived 10m LLM stream timeout cleanly paused) |

**Key progression**:
- **Run 2 → Run 3 (Runtime v2)**: Solved **system latency, observability, context budget, and input safety** (~7× faster than `ffmpeg` video loops, zero context compactions), but suffered **13 rescues** because permissive RGB road scoring (`88–97%` confidence on desert sand and canyon rock), post-pause `FINAL MINIMAP` occlusion, and full-throttle cornering pushed Tux off sharp bends.
- **Run 3 → Run 4 (Runtime v3, `e048851`)**: Cut total rescues by **85% (`13 → 2`)**, trajectory steps by **30% (`494 → 348`)**, and driving segments by **18% (`60 → 49`)**. Tux drove the **entire 270° nitro loop, narrow guardrailless wooden bridge, archway crate tunnel, and canyon `BTN.RB` drift with zero rescues**.

---

## 2. Core Lessons Learned

### Lesson 1: Turn-Based Tool-Calling VLMs Cannot Directly Close a 30–60 Hz Control Loop
- Tool-calling LLMs act at **0.05–0.2 Hz** (5–25s per turn), whereas 3D vehicles/characters integrate velocity and heading at **30–60 Hz**.
- Open-loop `sleep()` steering pulses accumulate quadratic lateral error ($\Delta y \approx \frac{1}{2} v \omega t^2$) and suffer **stop-and-go physics distortion** when pausing every 1–2s (in SuperTuxKart, karts understeer sluggishly for the first ~300ms from rest and rotate much faster at speed).
- **Rule**: Keep high-frequency lane/camera stabilization, stuck detection, and throttle modulation inside a **fast local loop (30–60 Hz)**, using the VLM only for tactical intent, obstacle/fork selection, UI reading, and special mechanics.

### Lesson 2: Annotated Contact Sheets Beat Recorded Video—*Only* If HUD Crops Precede Pause
- Recording `.mp4` screencasts and slowing them 4×–8× with `ffmpeg` (`Run 2`) burned 35–55% of frames on static `Paused` menus and degraded inference latency past 60s/turn as video tokens accumulated.
- Compositing 8 active-window tiles (`320×240`) with timestamp/motion badges (`+Tms Δ%`), stick vectors, and active button pills into **one JPEG** gave clear temporal debugging at ~1/5th the latency.
- **Run 3 bug (`FINAL MINIMAP` occlusion) & Run 4 fix**: SuperTuxKart **hides the HUD minimap and speedometer as soon as `BTN.START` opens the Pause screen**, drawing `Exit Race` over the bottom-left corner. Updating `controller.ts` in v3 to call `captureFullFrame(surface)` *before* tapping `BTN.START` restored **100% unobstructed `FINAL MINIMAP`, `FINAL TUTORIAL PROMPT`, and `FINAL LOOKAHEAD & ALERT` crops** across all 49 segments in Run 4.
- **Rule**: Always snapshot full-resolution HUD/minimap crops on the **final active frame *before* sending Pause**.

### Lesson 3: Multi-Cue Road Segmentation, Thresholded Centroids & Curvature Throttle Modulation
Run 3's v2 `driveServo` drove straight off 90° turns and wedged into walls while reporting **`avgRoadConfidence = 88–97%`** (`stopReason = "low_confidence"` fired `0/60` times). Upgrading `vision.ts` and `controller.ts` in **Runtime v3** solved all three root causes in Run 4:
1. **Negative-class penalties + thresholded column centroid (`navThreshold = 0.45`, `w = excess²`)**:
   - Adding `computeSandPenalty` (rejecting pale yellow desert sand where `lum > 145`, `yellowExcess > 28`, and `R - G < 35` while preserving reddish-brown dirt where `R - G >= 35`) and `wallPenalty` (comparing upper-horizon `y: 20%..28%` vs lookahead `y: 45%..52%` while exempting dark tunnel roofs) dropped off-road desert sand confidence from `91–97%` → **`6–14%`** (`seg-4`) and vertical beige canyon rock walls from `91%` → **`6%`** (`seg-31`), while keeping cobblestone, brown dirt, and wooden bridge planks at **`66–83%`**.
   - Zeroing sub-threshold columns eliminated centroid dilution, steering Tux dead-center around the entire **270° nitro loop** and **guardrailless wooden bridge** (`0` rescues vs `4` in Run 3).
2. **Kart-safe seed strips + read-only `inspectFrame()`**:
   - Sampling flanking road strips (`x: 0.28..0.39` and `0.61..0.72`) instead of Tux's sprite, freezing `roadModel` updates unless `roadConfidence >= 0.52 && |roadOffsetX| <= 0.36`, making `inspectFrame()` read-only (`mutateModel = false`), and resetting `roadModel` when `!unpause` prevented Main Menu graphics and off-road sand from ever poisoning road color adaptation.
3. **Curvature-coupled `throttleModulation`**:
   - Automatically pulsing `BTN.Y` to 50% duty when `|steer| > 0.44` and 33% duty when `|steer| > 0.68` visibly feathered throttle off on tight bends (`seg-27`), preventing high-speed corner launches.

### Lesson 4: Pause-Menu Edge Semantics, Button Overloads & API-Timeout Resilience
- **Ignored pre-held buttons**: Holding `BTN.Y` (gas) *before* tapping `BTN.A` (unpause) stalls Tux because SuperTuxKart requires a fresh button press *after* the pause dialog closes (`>= 220ms` settle).
- **Context-sensitive button overload & Main Menu stick navigation**: `BTN.A` confirms/unpauses in menus, activates **Look Behind** when unpaused in a race, and clicks the focused card if an extra segment runs after crossing the finish line back to the Main Menu. Likewise, STK's Main Menu ignores `DPAD_*` buttons completely—adding `pulseStick(0, x, y)` reduced Main Menu → Tutorial navigation to **1 stick pulse + 1 `BTN.A` tap**.
- **Pause-bounded resilience against LLM outages**: During Run 4 (`steps 255–256`), the model API hit two consecutive 5-minute `stream idle timeout (5m0s)` errors (`10m 10s` total downtime). Because `runChunk` / `driveServo` paused and zeroed all inputs inside `finally` before returning to the LLM, the game waited motionless in `Paused` and resumed on attempt 3 with **zero vehicle drift or state loss**.

### Lesson 5: Recovery Discipline Eliminates "Rescue Reward Hacking"
- In SuperTuxKart, Lakitu rescue (`BTN.BACK`) drops the kart forward on the track centerline—which let Run 3 use 13 rescues as a substitute for cornering.
- Restricting `smartRescue()` in Run 4 to true cliff/`WRONG WAY!` states and recovering minor 1–2m shoulder grazes via `runChunk` (`6/8` shoulder touches recovered directly onto pavement) cut rescues from **`13` → `2`**.

### Lesson 6: Ego-Centric 3D Cues Beat North-Up Minimap Guesses When Heading South
- On a static north-up minimap, moving downward (south) flips left and right relative to the driver's seat.
- Pairing unobstructed `FINAL MINIMAP` crops with the 2× zoomed `FINAL LOOKAHEAD & ALERT` crop (`<<<` wall chevrons, lampposts, banners) eliminated south-heading direction reversals at the canyon entrance and exit in Run 4.

### Lesson 7: Do Not Fight a Calibrated Servo With Manual `steerBias` (And Never Reverse on a Cliff Lip)
Analyzing the **only 2 rescues in Run 4** revealed two subtle agent-level pitfalls now codified in `SKILL.md` and `supertuxkart.md`:
1. **Opposing `steerBias` on curves (`seg-27` → `rescue #1`)**: Approaching the windmill hill crest, v3 `vision.ts` placed the cyan road centroid cleanly on the left-curving dirt road and feathered gas off—but the agent passed `steerBias: +0.15` (right) from an over-read minimap, pushing Tux onto the right ravine lip. **Rule**: Leave `steerBias: 0` on curves whenever `driveServo` has clear road contrast (`roadConfidence >= 0.65`); reserve `steerBias` strictly for lane selection past small obstacles (such as bananas) on straights.
2. **Reversing on a downward cliff lip (`seg-28`)**: When stopped parallel to the road on a steep outer lip, holding `BTN.X` (reverse) backed Tux down the slope into the ravine (`WRONG WAY!`). **Rule**: If perched on a sloped outer edge while facing roughly down-track, steer forward inward onto the road rather than reversing down the drop-off.
3. **Wide sandy canyon wash topology (`seg-31`–`seg-39` → `auto-rescue #1`)**: While `wallPenalty` prevented driving into canyon rock walls (`roadConf = 6%`), the Hacienda canyon entrance has a wide flat sandy wash pocket to the right of an inner rock outcrop + wooden lamppost. Documenting that exact fork (`stay left of the inner lamppost`) prevents exploratory turns against sloped canyon banks.

### Lesson 8: Sandbox, MCP, and Spec-Test Hygiene
- In Antigravity's network-isolated sandbox, `chrome-devtools` MCP (`evaluate_script` with inline `format: "script"` + `take_screenshot` omitting `filePath`) works natively with zero `BypassSandbox` prompts, whereas external WebSocket CLIs (`127.0.0.1:9222`) are blocked by sandbox network isolation and MCP `sourcePath` is blocked when `workspaceRoots` is unset.
- Every code snippet in `SKILL.md` must have a matching test in `packages/runtime/src/runtime.test.ts` (`14` unit tests / `73` assertions in v3).

---

## 3. Runtime v3 Validation Summary (`packages/runtime/` `3.0.0`)

All Runtime v3 upgrades proposed after Run 3 are now implemented, unit-tested (`bun test`), and empirically verified in Run 4 (`d19b18cf`):

| Upgrade | Implementation | Run 3 (v2) Behavior | Run 4 (v3) Verified Result |
| :--- | :--- | :--- | :--- |
| **Pre-pause HUD snapshot** | `captureFullFrame()` before `BTN.START` in `controller.ts` | `FINAL MINIMAP` occluded by `Exit Race` in 60/60 segments | **100% unobstructed** `FINAL MINIMAP`, `PROMPT`, and `LOOKAHEAD` in 49/49 segments |
| **Sand & vertical wall rejection** | `computeSandPenalty` + horizon `wallPenalty` + `navThreshold = 0.45` in `vision.ts` | `88–97%` confidence on sand & canyon rock (`low_confidence` fired 0×) | **`6–14%`** on desert sand & canyon rock; **`66–83%`** on road; **0 rescues** on 270° loop & bridge |
| **Anti-poisoning road model** | Kart-safe flanking seed strips + EMA freeze + read-only `inspectFrame()` | Adapted to sand/walls within ~0.5s | **0 model-poisoning events** from Main Menu through finish arch |
| **Curvature throttle modulation** | Duty-cycled `BTN.Y` in `driveServo` when `\|steer\| > 0.44` | Unconditional 100% gas overshot tight corners | Automatic gas feathering on tight bends (`seg-27`) |
| **Orange-gold `WRONG WAY!` & `pulseStick`** | Outlined glyph detector in `vision.ts`; `pulseStick()` in `gamepad.ts` | Missed orange-yellow `WRONG WAY!`; `DPAD` ignored on Main Menu | Clean `WRONG WAY!` detection; Main Menu → Tutorial in **1 `pulseStick` + 1 `BTN.A`** |

---

## 4. Would a Future Agent Solve This Task & Generalize to Other Real-Time Games?

### A. SuperTuxKart
- **Tutorial completion & clean driving (`0–2` rescues)**: **Yes, verified end-to-end.** Using `window.gameplayApi` v3 (`3.0.0`), `.agents/skills.json`, `skills/gameplay/SKILL.md`, and `skills/gameplay/references/supertuxkart.md`, Run 4 completed every tutorial mechanic and returned to the Main Menu in **49 segments / 348 steps with only 2 rescues**—and with the two Run 4 lessons (`steerBias: 0` on curves + canyon entrance lamppost landmark) now documented in `SKILL.md` and `supertuxkart.md`, a future agent has everything needed for a **0–1 rescue** run.
- **Live unpaused races against AI karts**: Requires running `driveServo` continuously *without* pause-chunking (`pause: false, unpause: false`) plus either **minimap-pose corner lookahead** (predicting 90° hairpins behind 3D hill crests before visual road pixels disappear) or a **learned visuomotor policy** to handle moving AI karts, slipstreaming, and item chaos in real time.

### B. Other Games (Video Output + Controller Input Only)

Our browser two-loop + contact-sheet architecture **does not generalize unchanged to all real-time games**. Its reach breaks down cleanly into three tiers:

| Game Tier | Examples | Works With Current Browser + Contact-Sheet Setup? | What Transfers vs. What Changes |
| :--- | :--- | :--- | :--- |
| **1. Turn-Based, Strategy, Deckbuilders, Menus, Puzzle** | *Slay the Spire*, *Balatro*, *Civilization*, *Persona* combat, RPG menus | **Yes, out of the box** | `gameplayApi` virtual gamepad + single JPEG screenshots solve these cleanly at 0.1–0.5 Hz without pausing or CV servos. |
| **2. Pause-Friendly Single-Player 3D Action / Driving** | *SuperTuxKart* solo, forgiving platformers, adventure games with clean pause | **Partially (scaffolding transfers; System 1 CV is game-specific)** | Virtual gamepad, `runChunk` `try/finally` safety, pre-pause contact sheets, and VLM tactical planning transfer directly. However, hand-coded RGB road rules in `vision.ts` must be swapped per genre (e.g., minimap/waypoint tracker, reticle servo). Fails if pausing hides gameplay with resume countdowns or wipes momentum. |
| **3. Unpausable Real-Time 3D, Dual-Stick Action, Competitive / Twitch** | *Elden Ring*, *Rocket League*, *Halo*, fighting games, online racers | **No with turn-based CDP tool calls** | Requires **continuous non-pausing execution** (<50ms control latency) and **learned visuomotor policies** rather than pause-chunked LLM tool calls + hand-tuned RGB heuristics. |

### C. Architecture Required for General Real-Time Gameplay (PC & Consoles)

To generalize across real-time 3D games from black-box video + controller I/O without per-game pixel hacks or pause-chunking:

1. **Replace Browser/CDP Transport With Direct Low-Latency Video + HID I/O**:
   - **Software streaming (PC / Xbox / PS5)**: Use a native receiver—Moonlight (`limelight-common-c`) for PC, standard WebRTC / OpenXbox for **Xbox Series X|S**, or `chiaki-ng` (`libchiaki`) for **PS5**—delivering raw 60 fps frames in **5–15ms** in-memory and sending 120+ Hz controller state directly over UDP/SCTP without browser tab throttling or CDP screenshot round-trips.
   - **Hardware ground truth (Consoles / Any HDMI Device)**: Use a **UVC HDMI capture card** (15–30ms uncompressed frames) + **wired USB HID microcontroller** (RP2040 / Pi USB gadget, <2ms input). Among current-gen consoles, **Xbox Series X|S** is easiest because gameplay HDMI has HDCP disabled by default and the official **Xbox Adaptive Controller** accepts standard USB HID joysticks with full console authentication.
2. **Replace Hand-Crafted RGB Heuristics With Learned System-1 Visuomotor Policies + VLM Planner**:
   - Run a compact local visuomotor policy (SIMA-2 / VPT / NitroGen-style vision-to-controller transformer at **20–30 Hz** on local GPU, or a persistent **2–5 Hz Gemini Live streaming session** interpolated by a 60 Hz local damper for medium-tempo games) to handle continuous dual-stick movement, camera control, and cornering.
   - Keep the frontier VLM asynchronous at **0.2–1 Hz** (never pausing the game) to read prompts/HUDs, interpret maps, detect stuck loops, and issue high-level tactical goals to System 1.
