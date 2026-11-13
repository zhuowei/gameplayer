# Gameplay Agent Lessons Learned & Generalization Guide

Empirical findings from three end-to-end attempts to complete **SuperTuxKart's Tutorial** under strict black-box constraints (**video output + virtual controller input only; zero game modifications**), along with an honest assessment of what generalizes to future runs and other real-time games.

---

## 1. Quantitative Comparison Across Three Runs

| Dimension | Run 1 (`43531a3d`) | Run 2 (`c0c05158`) | Run 3 (`2d0bd4ea` — Two-Loop + Contact Sheets) |
| :--- | :--- | :--- | :--- |
| **Control & Observation** | Unpaused open-loop pulses + 1 static PNG screenshot | Pause-bounded open-loop scripts + `screencast` + `ffmpeg` 8× MP4 | Pause-bounded 30 Hz `driveServo` / `runChunk` + 4×2 annotated JPEG contact sheet |
| **Wall-Clock Time** | ~55m (~19m setup failures + ~36.5m driving) | ~5h 18m (~8m setup + ~5h 10m driving) | **~46m** (~3m menu + **42m 58s** driving) |
| **Trajectory Steps** | 819 steps | 918 steps (2 context compactions) | **494 steps (0 compactions)** |
| **Driving Segments** | ~110 pulses | 137 video chunks | **60 segments** |
| **Per-Move Latency** | ~5–7s (blind to intermediate motion) | ~25–75s (CPU AV1→H.264 transcode + video token bloat) | **~10–15s** (in-memory canvas composite + 1 JPEG read) |
| **Mechanics Completed** | Partial (skipped backward fire & drifting) | **All** | **All** |
| **Rescues Used** | 3 manual rescues | Late adoption (spent 10–23 chunks reversing first) | **9 `smartRescue()` + 4 Lakitu auto-rescues (13 total)** |
| **State Desyncs** | 9m stream hang / window minimize | Post-compaction `ReferenceError` left game unpaused + brake latched | **0 unrecovered desyncs** (`try/finally` held throughout) |

**Key takeaway**: Run 3 solved **system latency, observability, context budget, and input safety** (~7× faster than Run 2, zero `ffmpeg`, zero compactions), **but driving quality remained poor (~C grade)**: 13 rescues on a ~60-second lap meant the agent routinely ran off sharp corners onto sand and used `smartRescue()` to snap back onto the centerline.

---

## 2. Core Lessons Learned

### Lesson 1: Turn-Based Tool-Calling VLMs Cannot Directly Close a 30–60 Hz Control Loop
- Tool-calling LLMs act at **0.05–0.2 Hz** (5–20s per turn), whereas 3D vehicles/characters integrate velocity and heading at **30–60 Hz**.
- Open-loop `sleep()` steering pulses accumulate quadratic lateral error ($\Delta y \approx \frac{1}{2} v \omega t^2$) and suffer **stop-and-go physics distortion** when pausing every 1–2s (in SuperTuxKart, karts understeer sluggishly for the first ~300ms from rest and rotate much faster at speed).
- **Rule**: Keep high-frequency lane/camera stabilization, stuck detection, and throttle modulation inside a **fast local loop (30–60 Hz)**, using the VLM only for tactical intent, obstacle/fork selection, UI reading, and special mechanics.

### Lesson 2: Annotated Contact Sheets Beat Recorded Video—*Only* If HUD Crops Precede Pause
- Recording `.mp4` screencasts and slowing them 4×–8× with `ffmpeg` (`Run 2`) burned 35–55% of frames on static `Paused` menus and degraded inference latency past 60s/turn as video tokens accumulated.
- Compositing 8 active-window tiles (`320×240`) with timestamp/motion badges (`+Tms Δ%`), stick vectors, and active button pills into **one JPEG** gave clear temporal debugging at ~1/5th the latency.
- **What went wrong in Run 3 (`FINAL MINIMAP` occlusion)**: SuperTuxKart **hides the HUD minimap and speedometer as soon as `BTN.START` opens the Pause screen**, drawing `Exit Race` over the bottom-left corner. Because `controller.ts` cropped `FINAL MINIMAP` *after* pressing `BTN.START`, the zoomed minimap crop was blank in all 60 segments—forcing the VLM to squint at tiny 320×240 tiles and misread four corners.
- **Rule**: Always snapshot full-resolution HUD/minimap crops on the **final active frame *before* sending Pause**.

### Lesson 3: Naive RGB Road Heuristics Fail via Centroid Dilution and Self-Poisoning Adaptation
Run 3's 30 Hz `driveServo` (`packages/runtime/src/vision.ts`) drove straight off 90° turns (`seg-7`, `seg-20`, `seg-37`) and wedged into walls (`seg-11`, `seg-48`) while reporting **`avgRoadConfidence = 88–97%`** (`stopReason = "low_confidence"` fired **0/60** times) due to three bugs:
1. **Permissive color distance + unthresholded centroid**: Under `colorDist`, brown dirt (`~0.85`), yellow desert sand (`~0.70`), plaster walls (`~0.65`), and sunlit beige canyon rock (`~0.78`) all scored high. Weighting all 24 columns by `s²` without zeroing sub-threshold columns meant 18 sand/wall columns outweighed 6 road columns on sharp bends—pulling `roadOffsetX` toward `0.0` (`|meanSteerX| <= 0.17`) instead of turning sharply.
2. **Self-poisoning online `roadModel` EMA**: Re-seeding `roadModel` (`alpha = 0.15` every 33ms) from `x: 0.38..0.62, y: 0.58..0.67` overlapped Tux's kart sprite and adapted within ~0.5s whenever Tux touched sand (`seg-11`) or faced a beige wall (`seg-48`), teaching the servo that off-road terrain *was* the road.
3. **Full throttle on tight corners**: Holding `BTN.Y = 1` unconditionally gave a turning radius wider than 90° hairpins and narrow bridges.
- **Rule**: Any pixel servo must **(a)** lock its road-color prototype once calibrated on confirmed centerline pavement (excluding the player sprite region), **(b)** subtract a strict threshold (`max(0, s - τ)^2`) and reject columns with low horizon/vertical wall edges so non-road columns contribute zero steering pull, and **(c)** reduce throttle (or pulse drift/brake) proportionally when `|steer|` exceeds `~0.45`.

### Lesson 4: Pause-Menu Edge Semantics and Button Overloads Must Be Calibrated Per Game
- **Ignored pre-held buttons**: Holding `BTN.Y` (gas) *before* tapping `BTN.A` (unpause) stalled Tux at `0.1%` motion (`seg-5`, `seg-8`) because SuperTuxKart requires a fresh button press *after* the pause dialog closes (`>= 220ms` settle).
- **Context-sensitive button overload**: In SuperTuxKart, `BTN.A` confirms/unpauses in menus, but activates **Look Behind** (180° rear camera) when unpaused—reversing apparent left/right steering if pause state ever desyncs.
- **Mandatory `try / finally`**: Wrapping every chunk in `try { ... } finally { pause(); resetAll(); }` completely eliminated the runaway unpaused/stuck-brake failure seen after context compaction in Run 2.

### Lesson 5: Unconstrained `smartRescue()` Encourages "Reward Hacking" Around Bad Cornering
- In SuperTuxKart, Lakitu rescue (`BTN.BACK`) drops the kart forward on the track centerline—even advancing past the wooden bridge (`seg-25`), corner apexes (`seg-38`, `seg-53`), and onto the finish line (`seg-59`).
- Telling the agent to call `smartRescue()` immediately whenever off-road avoided Run 2's 20-step reverse loops, **but** turned off-road crashes + rescue into a cheap substitute for braking and turning.
- **Rule**: Restrict `smartRescue()` to true stuck/cliff/`WRONG WAY!` states, recover minor 1–3m shoulder drifts via `runChunk` steering + throttle lift, and treat **total rescue count (manual + automatic)** as a first-class evaluation metric.

### Lesson 6: VLMs Systematically Flip Left/Right When Heading South on Fixed-North Minimaps
- Whenever the kart headed downward (south) on STK's north-up minimap (`seg-30`–`seg-32`, `seg-39`), the VLM repeatedly saw the track bend toward the left/right of the 2D map image and applied the *un-rotated* steering sign.
- **Rule**: Always anchor on **ego-centric 3D track signage** (`<<<` / `>>>` wall chevrons, curb tangents) first; when reading a fixed-north minimap, derive heading $\vec{h}$ from consecutive dot positions before mapping map curvature to driver left/right ($\text{sign}(\vec{h} \times \vec{t})$).

### Lesson 7: Sandbox, MCP, and Spec-Test Hygiene
- In Antigravity's network-isolated sandbox, `chrome-devtools` MCP (`evaluate_script` with inline `format: "script"` + `take_screenshot` omitting `filePath`) works natively with zero `BypassSandbox` prompts, whereas external WebSocket CLIs (`127.0.0.1:9222`) are blocked by sandbox network isolation and MCP `sourcePath` is blocked when `workspaceRoots` is unset.
- Every code snippet in `SKILL.md` must have a matching test in `runtime.test.ts` (Run 3 hit a live `TypeError` in `seg-8b` because `SKILL.md` used `api.BTN.B` while `createGamepadController()` omitted `BTN`).

---

## 3. Concrete Runtime v3 Upgrade Checklist (To Eliminate Off-Road Excursions in STK)

Before running a zero-rescue or AI-opponent benchmark in SuperTuxKart, apply these four targeted updates to `packages/runtime/`:

1. **Pre-pause full-res HUD snapshot (`controller.ts` + `vision.ts`)**:
   - Capture an unpaused full-resolution frame right *before* `finally` taps `BTN.START`, and pass that snapshot (not the post-pause `surface`) to `buildContactSheetCanvas` so `FINAL MINIMAP` and `FINAL TUTORIAL PROMPT` are 100% unobstructed.
2. **Thresholded road segmentation + non-poisoning calibration (`vision.ts`)**:
   - Exclude Tux's sprite (`x: 0.40..0.60, y: 0.52..0.72`) when sampling road color; freeze `roadModel` updates whenever `roadConfidence < 0.75` or `|roadOffsetX| > 0.25`.
   - Penalize high-luminance yellow sand and vertical wall texture/horizon drop, and zero out column scores below `τ = 0.65` before computing the centroid so 6 true road columns steer decisively (`±0.75`) instead of averaging with 18 sand columns to `0.0`.
3. **Curvature-coupled throttle modulation (`controller.ts`)**:
   - In `driveServo`, pulse or release `gasButton` when `|steer| > 0.45` so the kart slows enough to make 60–90° turns without understeering onto sand.
4. **Yellow-orange `WRONG WAY!` banner detection (`vision.ts`)**:
   - Broaden upper-center alert detection from pure red (`R - G > 65`) to include high-contrast yellow/orange warning text outlined in dark pixels during active motion.

---

## 4. Would a Future Agent Solve This Task & Generalize to Other Real-Time Games?

### A. SuperTuxKart
- **Tutorial completion**: **Yes, reliably today (~25–45 min)** using the committed runtime (`9e10b26`), `.agents/skills.json`, `skills/gameplay/SKILL.md`, and `skills/gameplay/references/supertuxkart.md`. All button mappings, pause-edge timings, overload traps, crest directions, and the true finish-arch location are documented.
- **Clean driving (`0–1` rescues) & live unpaused races against AI karts**: **Requires the 4 Runtime v3 fixes in Section 3** (or a minimap-pose servo). With v2 (`9e10b26`) alone, a careful agent that shortens `driveServo` horizons (`~1800ms`) and switches to `runChunk` before every sharp corner can cut rescues substantially (~2–4), but unpaused competitive racing needs closed-loop corner braking and non-diluted road/minimap tracking.

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
