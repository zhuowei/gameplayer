# Gameplay Agent Toolkit

Tools, browser runtime, third-party 3D depth/OpenCV perception, and agent skills for playing **unmodified video games** strictly through **rendered video pixels** (`<canvas>` / `<video>`) and **virtual controller inputs** (`navigator.getGamepads()`).

## Architecture Overview

Driving a 30–60 Hz continuous game directly through a 0.1 Hz turn-based LLM tool loop fails due to inference latency, open-loop drift, and video-transcoding overhead. This repository implements a **two-loop + pretrained 3D depth/OpenCV + annotated contact-sheet** stack for browser game streaming clients (MoonlightWeb, Xbox Cloud/Remote Play):

1. **[packages/runtime](packages/runtime/README.md) (`window.gameplayApi` `5.0.1`)**
   - Overrides `navigator.getGamepads()` with an Xbox-standard 17-button, 4-axis virtual controller (`BTN`, `setButton`, `tapButton`, `setStick`, `pulseStick`, `rampStick`, `resetAll`) that adopts native `Gamepad`, `GamepadButton`, and `GamepadEvent` prototypes (safely shadowing WebIDL prototype getters), emits `performance.now()` timestamps, and returns a standard 4-slot `[simGamepad, null, null, null]` array.
   - **System 1 (`driveServo` `v5.0.1`, `7000ms` default adaptive horizon)**: Non-blocking in-page **Depth Anything V2 Small (`280×210`) `Blob` Web Worker** (`initDepthEngine`), **30 Hz stateful `MinimapTracker`** ego-frame odometry with cobblestone-safe stroke filtering (`turnAhead`), biome-agnostic pure-pursuit road/shoulder segmentation (with striped-curb & underwater stone-pillar rejection), 3-tier foreground obstacle depth avoidance, curvature-coupled throttle & corner braking, in-loop **`autoUnwedge`** stuck/3D-pin recovery, and hardened post-race **`stopOnRaceFinish`** detection.
   - **System 2 (`runChunk`, `smartRescue`, `resetRoadModel`)**: Pause-bounded or unpaused (`{ unpause: false, pause: false }`, preserving 4×2 motion tiles and `shouldAbort()` wall-pinning aborts for unpausable 3D / cloud-streamed games) scripted maneuvers wrapped in `try / finally` that neutralize all inputs before pressing `BTN.START` pause so steering pulses never scroll STK's horizontal Pause menu.
   - **Pre-Pause Annotated Contact Sheets**: Captures unobstructed full-resolution HUD crops (`MINIMAP`, `TUTORIAL PROMPT`, `LOOKAHEAD & ALERT`) *before* pausing (skipping pause on post-race scoreboards) and renders a deterministic 4×2 timestamped grid for single-JPEG inspection.
2. **[packages/perception](packages/perception/index.ts) (`bun run perceive`)**
   - Offline host-side 3D & geometric perception CLI (~400 ms inside Standard Sandbox Mode with zero network access) powered by **quantized Depth Anything V2 Small** (`@huggingface/transformers` + `onnxruntime-node`), **OpenCV 5.0** (`@techstark/opencv-js` Canny/Hough vanishing point + Difference-of-Gaussians minimap ribbon & ego-heading curvature), and **`sharp`**.
3. **[packages/browsertool](packages/browsertool/README.md)**
   - Zero-dependency Bun CLI speaking raw Chrome DevTools Protocol (`ws://127.0.0.1:9222`) for environments outside network-isolated sandboxes (inside Antigravity's sandbox, use the native `chrome-devtools` MCP server instead).
4. **[skills/gameplay](skills/gameplay/SKILL.md) (Registered via [.agents/skills.json](.agents/skills.json))**
   - Progressive-disclosure agent skill covering runtime `v5.0.1` injection, `bun run perceive` 3D depth/OpenCV integration, zero-shot unseen track protocol, recovery discipline, the [SuperTuxKart runbook](skills/gameplay/references/supertuxkart.md), and the [GTA V runbook](skills/gameplay/references/gtav.md).

## Empirical Results

Across eight end-to-end black-box evaluations (six SuperTuxKart runs, one Tier-3 cloud-streaming test on *Fortnite: Save the World*, and a supervised dual-agent *Grand Theft Auto V* session, backed by `35` tests / `207` assertions via `bun test`):

| Run | Target & Scenario | Stack | Steps / Segments | Outcome & Rescues | Key Finding |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Runs 1–2** | STK Tutorial (exploratory baselines) | Raw pulses / `ffmpeg` 8× MP4 | 819–918 steps / 110–137 chunks | 3 rescues (later-adopted); ~55m–5h 18m | Established need for real-time inner servo + single-JPEG contact sheets ([lessons](docs/lessons-learned.md#1-quantitative-comparison-across-runs)) |
| **Run 3** (`2d0bd4ea`) | STK Tutorial | Runtime v2 + Flash (`Hydrogen`) | 494 steps / 60 segments | Completed; **13 rescues** (~46m) | ~7× faster than MP4, but post-pause `FINAL MINIMAP` occluded & permissive sand/wall RGB |
| **Run 4** (`d19b18cf`) | STK Tutorial | Runtime v3 + Pro (`Carbon`) | **348 steps / 49 segments (−30% steps)** | Completed; **2 rescues (−85%)** | Pre-pause HUD crops + sand/wall penalties + `throttleModulation` cleared 270° loop cleanly |
| **Run 5** (`52098352`) | STK *Antediluvian Abyss* (unseen figure-8, 3 AI) | Runtime v4 + `perceive` (10×) + `Hydrogen` | 732 steps / 108 segments | **Finished 4th place**; **6 rescues** (`44m 57s`) | Zero-shot completion in underwater biome; `86%` wall-clock spent in ~20s pause/MCP turns |
| **Run 6** (`b05c9314`) | STK *Blackhill Mansion* (unseen night cobblestones) | Runtime `v5.0.0` (in-page Depth Worker, `0` `perceive`) | **330 steps (−55%) / 40 segments (−63%)** | ~90–95% lap (`seg-40` Pause stick leak); **8 rescues** (`21m 22s`) | In-page `280×210` Depth Worker eliminated host `perceive` calls; exposed 4 bugs fixed in [`v5.0.1`](docs/lessons-learned.md#e-run-6-zero-shot-evaluation-blackhill-mansion-runtime-v500--runtime-v501-fixes) |
| **Run 7** (`50539d32`) | *Fortnite: Save the World* (`play.xbox.com`, Tier 3) | Runtime `v5.0.1` + `Hydrogen` (`~16m` active) | 296 steps | Preview UI failed → **Production UI navigated Homebase → Stonewood basement** before AFK kick | Isolated Preview (`⋮⋮`) vs Production (`[Xbox Logo \| ⋮⋮]`) UI; drove prototype fidelity, CSP policy & unpaused `runChunk` ([lessons](docs/lessons-learned.md#f-cross-game-tier-3-evaluation-fortnite-save-the-world-on-xbox-cloud-gaming-50539d32)) |
| **Run 8** (`eae11737`) | *Grand Theft Auto V* (`MoonlightWeb`, Tier 3) | Supervised dual-agent (`Hydrogen` player + supervisor `.mp4` + hot-injected `v5.0.1`) | `1h 18m` session (`02:29–03:47`) | Cleared Prologue shootout past depot gate (**13 deaths total → 0 deaths in final 18m**) | Supervisor 1 fps `.mp4` review + live hot-injected `readGtavRadar`, `autoCombatSweep`, `sprintMove`, and `gtavDrive` eliminated turn-gap/flank deaths; next bottleneck is on-foot waypoint orientation ([lessons](docs/lessons-learned.md#g-supervised-dual-agent-tier-3-evaluation-grand-theft-auto-v-on-moonlightweb-eae11737)) |

See [docs/lessons-learned.md](docs/lessons-learned.md#b-other-games-video-output--controller-input-only) for the full 3-tier cross-game generalization breakdown and [Section 6](docs/lessons-learned.md#6-reusable-supervised-gameplay-prompt-coordinator--player-subagent) for the reusable supervised gameplay prompt.

## Documentation & Post-Mortems

- **[AGENTS.md](AGENTS.md)**: Always-on workspace rules, sandbox/MCP conventions, and mandatory vision/control testing invariants.
- **[docs/lessons-learned.md](docs/lessons-learned.md)**: Quantitative comparison across six SuperTuxKart runs (four Tutorial iterations cutting rescues `13 → 2`, Run 5 zero-shot Singleplayer *Antediluvian Abyss* with Runtime v4 + `bun run perceive`, and Run 6 zero-shot *Blackhill Mansion* with Runtime `v5.0.0` → `v5.0.1`), cross-game Tier-3 evaluations (*Fortnite: Save the World* on `play.xbox.com` and supervised *Grand Theft Auto V* on MoonlightWeb with a reusable dual-agent prompt), step-sizing tradeoffs, why moving 3D depth/minimap odometry into the real-time loop eliminates 86% turn overhead, and foundation-model caveats (NitroGen, SIMA 2).

## Quick Start

```sh
# Bundle packages/runtime/gameplay-runtime.js (v5.0.1) & .cache/gameplay-depth-bundle.js
bun run build

# Run offline Depth Anything V2 + OpenCV perception on a screenshot
bun run perceive /path/to/screenshot.jpg

# Run unit & integration tests across runtime, perception, and browsertool
bun test
```
