# Gameplay Agent Lessons Learned & Generalization Guide

Empirical findings from five end-to-end SuperTuxKart runs under strict black-box constraints (**video output + virtual controller input only; zero game modifications**): four iterative runs on the **Tutorial** (`Raw Screenshots → Video Chunks → Runtime v2 → Runtime v3`) plus a **Run 5 zero-shot test on an unseen Singleplayer track (*Antediluvian Abyss*)** using **Runtime v4 (`window.gameplayApi` `4.0.0`)** and offline **Depth Anything V2 + OpenCV (`bun run perceive`)**, along with causal attribution across tools, step sizing, and real-time loop boundaries.

---

## 1. Quantitative Comparison Across Five Runs

| Dimension | Run 1 (`43531a3d` — Tutorial) | Run 2 (`c0c05158` — Tutorial) | Run 3 (`2d0bd4ea` — Tutorial, v2) | Run 4 (`d19b18cf` — Tutorial, v3) | Run 5 (`52098352` — *Antediluvian Abyss* Zero-Shot, v4) |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Track & Prior Knowledge** | Tutorial (exploratory) | Tutorial (exploratory) | Tutorial (exploratory) | Tutorial + `supertuxkart.md` runbook | **Unseen Singleplayer figure-8 (*Antediluvian Abyss*, 1 Lap, 3 AI)** |
| **Model & Reasoning** | Frontier VLM | Frontier VLM | **Gemini 4 Hydrogen (Flash-tier, High)** | **Gemini 4 Carbon (Pro-tier, Medium)** | **Gemini 4 Hydrogen (Flash-tier, Medium)** |
| **Control & Observation** | Unpaused open-loop pulses + 1 static PNG | Pause-bounded scripts + `screencast` + `ffmpeg` 8× MP4 | Pause-bounded 30 Hz `driveServo` v2 + post-pause 4×2 JPEG sheet | 30 Hz multi-cue `driveServo` v3 + pre-pause 4×2 JPEG sheet | **30 Hz biome-agnostic `driveServo` v4 + `bun run perceive` (Depth Anything V2 + OpenCV, 10×)** |
| **Menu → Grid Time** | ~19m (setup/input failures) | ~8m | ~3m (`DPAD` trial-and-error) | **2m 37s** (1 `pulseStick` + 1 `BTN.A`) | **~3m 50s** (zero-shot Singleplayer setup + track grid) |
| **Total Wall-Clock Time** | ~55m (~36.5m driving) | ~5h 18m (~5h 10m driving) | **~46m** (~3–5s/turn Flash inference) | **~1h 47m active** (~15–25s/turn Pro inference; +10m API timeout) | **44m 57s** (`~6m 06s` active driving + `~1m 32s` idle check; `07:38.2` race clock vs AI `02:00.403`) |
| **Trajectory Steps** | 819 steps | 918 steps (2 compactions) | 494 steps (0 compactions) | **348 steps (0 compactions, −30% vs Run 3)** | **732 steps** (`406` to premature finish claim at `seg-55` + `326` to true finish at `seg-109`) |
| **Driving Segments** | ~110 pulses | 137 video chunks | 60 segments | **49 live segments (−18% vs Run 3)** | **108 completed segments** (`66` `driveServo` + `42` `runChunk`) |
| **Task Completion** | Partial (skipped 2) | **All** | **All** | **All** | **Finished 1-Lap Race (4th place, verified post-race scoreboard)** |
| **Off-Road Excursions** | Frequent | Frequent (10–23 step reverse loops) | ~15 deep crashes onto sand/walls | **8 total (6 shallow shoulder grazes self-recovered on-road)** | **4 water falls** (+ ~14 shallow curb/arch wall grazes recovered via `runChunk`) |
| **Total Rescues Used** | 3 manual rescues | Late adoption after long reverse loops | 13 total (`9` `smartRescue` + `4` Lakitu) | **2 total (`1` `smartRescue` + `1` Lakitu, −85% vs Run 3)** | **6 total (`2` `smartRescue` + `4` Lakitu)** |
| **State Desyncs** | 9m stream hang | Unpaused + latched brake after error | **0** | **0** (survived 10m LLM stream timeout cleanly paused) | **1 false-finish unpause** (`seg-55`: misread figure-8 intersection as finish line) |

**Key progression & causal attribution**:
- **Run 2 → Run 3 (Runtime v2, ~95% tooling)**: Solved **system latency, observability, context budget, and input safety** (~7× faster than `ffmpeg` video loops, zero context compactions), even on a faster Flash-tier model (`Gemini 4 Hydrogen`). However, driving suffered **13 rescues** because permissive RGB road scoring (`88–97%` confidence on desert sand and canyon rock), post-pause `FINAL MINIMAP` occlusion, and full-throttle cornering pushed Tux off sharp bends.
- **Run 3 → Run 4 (Runtime v3 `e048851` + Skill/Runbook + Carbon Pro)**: Cut total rescues by **85% (`13 → 2`)**, trajectory steps by **30% (`494 → 348`)**, and driving segments by **18% (`60 → 49`)**, while total wall-clock time increased (`46m → 1h 47m` active) due to switching from **Hydrogen (Flash-tier, ~3–5s/turn)** to **Carbon (Pro-tier, ~15–25s/turn)**. Breaking down the `13 → 2` rescue reduction across the three changes:
  1. **~50–55% Runtime v3 Tools (`vision.ts` + `controller.ts`)**: Sand/wall rejection, thresholded column centroids, throttle modulation, and unobstructed pre-pause HUD crops enabled pure `driveServo` to clear the entire **270° nitro loop and guardrailless wooden bridge with 0 rescues** (vs. 4 rescues in Run 3) without custom scripts.
  2. **~25–30% Codified Policy & Track Runbook (`SKILL.md` + `supertuxkart.md`)**: Replacing Run 3's *"call `smartRescue()` immediately when off-track"* instruction with `runChunk` shoulder recovery saved ~5–6 rescues, and pre-mapping the menu path, 90° courtyard turn, and true adobe finish arch saved ~2–3 rescues and ~15 steps.
  3. **~15–20% Model Tier Upgrade (`Hydrogen` Flash → `Carbon` Pro)**: Stronger multi-phase `runChunk` synthesis (`brake → rampStick → throttle feathering`) helped recover 6/8 shoulder grazes cleanly on the first try—though even Carbon (Pro) still flipped south-heading north-up minimap geometry twice (`seg-27` and `seg-30`), confirming that Pro-tier reasoning complements but cannot replace calibrated local perception/control.

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
- In Antigravity's network-isolated sandbox, `chrome-devtools` MCP (`evaluate_script` with inline `format: "script"` + `take_screenshot` omitting `filePath`) and offline `bun run perceive` (with `.cache/models` pre-populated and `env.allowRemoteModels = false`) work natively with zero `BypassSandbox` prompts, whereas external WebSocket CLIs (`127.0.0.1:9222`) are blocked by sandbox network isolation and MCP `sourcePath` is blocked when `workspaceRoots` is unset.
- Every code snippet in `SKILL.md` must have a matching test in `packages/runtime/src/runtime.test.ts` (`21` unit/integration tests / `102` assertions across `runtime`, `perception`, and `browsertool` in v4).

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

## 4. Run 5 Zero-Shot Evaluation: Unseen Singleplayer Track (*Antediluvian Abyss*, Runtime v4 + `bun run perceive`)

To test whether our upgrades genuinely generalize beyond the memorized Tutorial course, Run 5 (`52098352`) launched on **Gemini 4 Hydrogen (Medium)** with zero track-specific prompts, navigated Singleplayer menus to an unseen underwater figure-8 track (*Antediluvian Abyss*, 1 Lap, Novice, Time Trial, 3 AI karts), and completed the race (`"You finished the race in rank 4!"`, post-race scoreboard verified).

### A. Did the Runtime v4 + Third-Party Perception Changes Help?
**Mixed — yes on zero-shot biome generalization and 3D obstacle recovery; no on multi-surface lane centering, lap-progress verification, and overall turn efficiency.**

1. **What clearly helped**:
   - **Zero-shot completion in an alien biome (`6` rescues vs. `13` in Run 3)**: *Antediluvian Abyss* violates desert/asphalt assumptions—its "sky" is dark underwater blue, bridges are grey metal grates flanked by bright blue-and-white striped curbs, and stone colonnade pillars split the road. Runtime v4's sky-adaptive `wallPenalty` and mode-seeking `computeCorridorCentroid()` maintained `55–74%` road confidence and finished an unseen figure-8 course on `Hydrogen (Medium)` with **half the rescues (`6` vs `13`)** that `Hydrogen (High)` needed on the simpler Tutorial track in Run 3.
   - **Offline 3D depth (`Depth Anything V2 Small` + `OpenCV 5.0`, `~620–660ms` in sandbox)**: Whenever RGB confidence stayed misleadingly high (`50–75%`) while facing stone pillars or arch walls, `bun run perceive` pinpointed the true 3D opening:
     - `seg-24`: Detected a center colonnade pillar (`centerClearance: 0`, `corridorOffsetX: -0.69`), steering cleanly left around it;
     - `seg-77` & `seg-92`: Caught frontal arch-wall wedges (`centerClearance: 0.15` → `corridorOffsetX: +0.60`; `centerClearance: 0.34` → `corridorOffsetX: -0.69`), immediately prescribing the correct unwedge turn direction.
2. **What fell short or created new friction**:
   - **Two-tone road decks + `resetRoadModel()` curb locking (`seg-60`–`seg-109`)**: *Antediluvian Abyss* bridges combine a dark grated center deck with wide blue-and-white striped curbs. Calling `resetRoadModel()` after curb recoveries seeded one of the flanking strips (`x: 0.28..0.39` / `0.61..0.72`) onto the bright curb instead of the center grate, biasing `driveServo` toward the outer edge and causing **~14 stone-arch wall scrapes** and **2 late-lap bridge water falls** (`seg-89`, `seg-94`).
   - **False `autoCornerBrake` on uphill ramps & striped curbs (`seg-19`, `seg-57`)**: 2D RGB curvature spiked (`|meanCurvature| = 0.63–0.74`) on uphill perspective foreshortening and diagonal curb stripes, pulsing `BTN.X` (brake) on clear ramps or stalling acceleration from standstill (`seg-57` `stuckDetected: true`).
   - **Single-frame minimap ambiguity at figure-8 intersections (`seg-55` false finish)**: Because a single static minimap frame has no velocity vector (`headingDeg: null` in 10/10 `perceive` calls), when Tux crossed the figure-8 overpass/underpass intersection heading **North** at `02:13.875` (`seg-55`), Tux's round icon sat directly beside the East-West finish-line tick—tricking the VLM (and initial review) into mistaking `1/1` + three AI checkered flags for race completion when Tux was only ~60% through the lap.

### B. Would Larger or Smaller Steps Help?
**Neither uniformly—under pause-chunked control, fixed step duration has a sharp U-shaped failure curve, and `2.2–2.5s` sat pinched between both walls:**

- **Why smaller fixed steps (`< 1.5s`) hurt**: Every pause-bounded step pays `220ms` unpause settle + `~350–400ms` low-speed acceleration where kart turn-in sluggishly understeers (`controller.ts` suppresses throttle modulation for the first `380ms` just to build speed), plus **`~12–20s` of MCP screenshot + VLM inference overhead**. Halving step size to `1.2s` would double trajectory steps (`>200` segments, `>80m` wall-clock) while spending a third of every chunk accelerating from near-rest.
- **Why larger blind steps (`4–6s`) also hurt with an RGB-only inner loop**: On narrow colonnade bridges, lateral drift into an arch pillar or off an unguarded edge happened in **`1.6–2.5s`** (`seg-89` water fall at `+1.67s`, `seg-94` at `+1.85s`, `seg-101` pillar wedge at `+2.55s`). Extending fixed chunks to `5s` without upgrading inner-loop 3D perception would convert minor wall grazes into deep off-track rescues.
- **What *would* help — Adaptive Event-Driven Horizons (`6–10s` max, `<250ms` hazard interrupt)**: Run **much larger steps (`6–10s`, or continuous unpaused)** whenever 3D corridor clearance and centerline confidence are high, while triggering an **immediate sub-second early stop** only on true events (3D `centerClearance < 0.35`, topological fork, sharp hairpin, `stuck`, or HUD finish banner). That gives both high momentum on straights/sweepers and sub-second reaction at hazards.

### C. Should We Move More Into the Real-Time Loop?
**Yes — decisively.** Dissecting Run 5's `44m 57s` (`2,697s`) wall-clock budget exposes the bottleneck:
- **Active in-game driving**: `~366s` (`~6.1m`, vs Novice AI `2m 00s` — slowed ~3× by stop-and-go pauses and 14 curb-wedge reversals).
- **Turn-by-turn pause/MCP/VLM overhead**: **`~2,240s` (`86%` of total wall-clock time across `108` segments / `732` steps)** — roughly **`20s` of tool/LLM overhead for every `2.5s` of driving**.

Moving four deterministic/geometric capabilities from the `0.05 Hz` VLM loop into the **`10–30 Hz` real-time loop** eliminates most of those 108 segments:
1. **In-loop 3D free-space corridor (`8–15 Hz` Depth Anything V2 via WebGPU / persistent local daemon)**: Fusing 3D depth directly inside `driveServo` avoids center pillars (`seg-24`, `seg-77`) and arch walls (`seg-92`, `seg-108`) *without pausing*, treats two-tone grated decks + striped curbs as a single flat 3D surface bounded by vertical walls (`seg-68`–`seg-101`), and prevents `autoCornerBrake` from braking on uphill ramps (`seg-19`).
2. **Temporal minimap odometry ($\Delta x, \Delta y \rightarrow \theta_{\text{heading}}, \text{lapProgress}$)**: Differencing player minimap coordinates across consecutive frames inside the 30 Hz loop yields exact ego heading and disambiguates figure-8 overpasses from finish lines (`seg-55`, where $\vec{v} = \text{North}$ vs. finish line $\vec{v} = \text{East}$).
3. **Local stuck-unwedge reflex (`reverse + steer toward max depth sector`)**: In Run 5, the VLM hand-authored the same `450ms BTN.X reverse → steer toward open corridor` `runChunk` **14 separate times**. Executing a bounded 1-second reverse-and-realign reflex locally inside `driveServo` before escalating to the VLM saves ~14 turns (`~5m` wall-clock) and preserves race flow.
4. **Explicit HUD finish / scoreboard detector**: Detecting the `"You finished the race"` banner or checkered-flag state inside the loop prevents premature stops (`seg-55`) and terminates cleanly the instant the finish line is crossed (`seg-109`).

With those four upgrades in System 1, System 2 (the VLM) shifts from a **2.5-second micro-chauffeur** (`108` calls/lap) to an **event-driven / asynchronous tactical supervisor** (`~8–15` check-ins/lap for menus, true forks, item strategy, and double-stuck anomalies), cutting unseen-track wall-clock time from **~45 minutes to ~3–5 minutes** and in-game lap times from **~6–7 minutes toward ~2.5 minutes**.

---

## 5. Would a Future Agent Solve This Task & Generalize to Other Real-Time Games?

### A. SuperTuxKart
- **Tutorial completion & clean driving (`0–2` rescues)**: **Yes, verified end-to-end.** Using `window.gameplayApi` v3 (`3.0.0`), `.agents/skills.json`, `skills/gameplay/SKILL.md`, and `skills/gameplay/references/supertuxkart.md`, Run 4 completed every tutorial mechanic and returned to the Main Menu in **49 segments / 348 steps with only 2 rescues**—and with the two Run 4 lessons (`steerBias: 0` on curves + canyon entrance lamppost landmark) now documented in `SKILL.md` and `supertuxkart.md`, a future agent has everything needed for a **0–1 rescue** run.
- **Unseen Singleplayer tracks (zero-shot completion vs. competitive AI lap times)**: **Zero-shot completion is now verified (`Run 5`, *Antediluvian Abyss*, 4th place)** using Runtime v4 + `bun run perceive`. Closing the remaining speed gap (`~6.1m` active driving vs. Novice AI `2m 00s`) and cutting wall-clock time (`45m` → `~3–5m`) requires moving 3D depth corridor steering, temporal minimap odometry, and stuck-unwedge reflexes into a **continuous non-pausing (`pause: false`) real-time loop** as detailed in Section 4.C.

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
2. **Replace Hand-Crafted RGB Heuristics With Geometric Depth/CV or Fine-Tuned Visuomotor Policies + VLM Planner**:
   - **Important caveats on current "generalist gaming agent" models**:
     - **NitroGen is not yet real-time/asynchronous out of the box**: NVIDIA's NitroGen paper evaluated by hooking the game engine's system clock to freeze physics between action chunks (*"We leave real-time or asynchronous deployment to future work"*—the OS-level equivalent of our `BTN.START` pause loop). Deploying flow-matching/diffusion gamepad policies against live unpaused wall-clock games requires an asynchronous receding-horizon / delay-compensated execution harness.
     - **SIMA 2 requires embodied SFT + RL (un-fine-tuned `Flash-Lite` is ~3–7%)**: Although SIMA 2 uses a **Gemini Flash-Lite** backbone, un-fine-tuned baseline Flash-Lite achieves only **~3.2%–7.0%** on 3D virtual-world tasks (vs. **~65–66%** after mixed SFT + RL on gameplay action trajectories) because generic pretraining lacks calibrated continuous motor gain (`stickX × ms → Δheading`), and MCP screenshot/script round-trips cap agent frequency at ~0.2–0.4 Hz.
   - **What works practically today without proprietary gameplay SFT**:
     - **Option 1 (Zero-shot with off-the-shelf VLMs + Geometric System 1)**: Use pretrained **monocular depth / segmentation** (`onnxruntime-web` / `onnxruntime` running *Depth Anything V2 Small*) + **optical flow & minimap skeleton/pose tracking** (`opencv.js` / OpenCV + Pure Pursuit) at **30–60 Hz** for free-space steering and obstacle avoidance, while an un-fine-tuned Gemini planner runs asynchronously at **0.5–1 Hz** outputting **2D screen-space target coordinates `(u, v)`** and discrete tactical intents rather than raw `(stickX, durationMs)` pulses.
     - **Option 2 (Learned end-to-end twitch control)**: Distill or fine-tune a compact local visuomotor policy (`<50M` params, ~5–10ms inference on local GPU with receding-horizon chunk blending) on 30–60 minutes of recorded `(video, gamepad)` traces, supervised high-level by an asynchronous VLM.
