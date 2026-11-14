# Gameplay Agent Toolkit

Tools, browser runtime, third-party 3D depth/OpenCV perception, and agent skills for playing **unmodified video games** strictly through **rendered video pixels** (`<canvas>` / `<video>`) and **virtual controller inputs** (`navigator.getGamepads()`).

## Architecture Overview

Driving a 30–60 Hz continuous game directly through a 0.1 Hz turn-based LLM tool loop fails due to inference latency, open-loop drift, and video-transcoding overhead. This repository implements a **two-loop + pretrained 3D depth/OpenCV + annotated contact-sheet** stack for browser game streaming clients (MoonlightWeb, Xbox Cloud/Remote Play):

1. **[packages/runtime](packages/runtime/README.md) (`window.gameplayApi` `5.0.1`)**
   - Overrides `navigator.getGamepads()` with an Xbox-standard 17-button, 4-axis virtual controller (`BTN`, `setButton`, `tapButton`, `setStick`, `pulseStick`, `rampStick`, `resetAll`).
   - **System 1 (`driveServo` `v5.0.1`, `7000ms` default adaptive horizon)**: Non-blocking in-page **Depth Anything V2 Small (`280×210`) `Blob` Web Worker** (`initDepthEngine`), **30 Hz stateful `MinimapTracker`** ego-frame odometry with cobblestone-safe stroke filtering (`turnAhead`), biome-agnostic pure-pursuit road/shoulder segmentation (with striped-curb & underwater stone-pillar rejection), 3-tier foreground obstacle depth avoidance, curvature-coupled throttle & corner braking, in-loop **`autoUnwedge`** stuck/3D-pin recovery, and hardened post-race **`stopOnRaceFinish`** detection.
   - **System 2 (`runChunk`, `smartRescue`, `resetRoadModel`)**: Pause-bounded scripted maneuvers wrapped in `try / finally` that neutralize all inputs before pressing `BTN.START` pause so steering pulses never scroll STK's horizontal Pause menu.
   - **Pre-Pause Annotated Contact Sheets**: Captures unobstructed full-resolution HUD crops (`MINIMAP`, `TUTORIAL PROMPT`, `LOOKAHEAD & ALERT`) *before* pausing (skipping pause on post-race scoreboards) and renders a deterministic 4×2 timestamped grid for single-JPEG inspection.
2. **[packages/perception](packages/perception/index.ts) (`bun run perceive`)**
   - Offline host-side 3D & geometric perception CLI (~400 ms inside Standard Sandbox Mode with zero network access) powered by **quantized Depth Anything V2 Small** (`@huggingface/transformers` + `onnxruntime-node`), **OpenCV 5.0** (`@techstark/opencv-js` Canny/Hough vanishing point + Difference-of-Gaussians minimap ribbon & ego-heading curvature), and **`sharp`**.
3. **[packages/browsertool](packages/browsertool/README.md)**
   - Zero-dependency Bun CLI speaking raw Chrome DevTools Protocol (`ws://127.0.0.1:9222`) for environments outside network-isolated sandboxes (inside Antigravity's sandbox, use the native `chrome-devtools` MCP server instead).
4. **[skills/gameplay](skills/gameplay/SKILL.md) (Registered via [.agents/skills.json](.agents/skills.json))**
   - Progressive-disclosure agent skill covering runtime `v5.0.1` injection, `bun run perceive` 3D depth/OpenCV integration, zero-shot unseen track protocol, recovery discipline, and the [SuperTuxKart runbook](skills/gameplay/references/supertuxkart.md).

## Documentation & Post-Mortems

- **[AGENTS.md](AGENTS.md)**: Always-on workspace rules, sandbox/MCP conventions, and mandatory vision/control testing invariants.
- **[docs/lessons-learned.md](docs/lessons-learned.md)**: Quantitative comparison across six SuperTuxKart runs (four Tutorial iterations cutting rescues `13 → 2`, Run 5 zero-shot Singleplayer *Antediluvian Abyss* with Runtime v4 + `bun run perceive`, and Run 6 zero-shot *Blackhill Mansion* with Runtime `v5.0.0` → `v5.0.1`), step-sizing tradeoffs, why moving 3D depth/minimap odometry into the real-time loop eliminates 86% turn overhead, and foundation-model caveats (NitroGen, SIMA 2).

## Quick Start

```sh
# Bundle packages/runtime/gameplay-runtime.js (v5.0.1) & .cache/gameplay-depth-bundle.js
bun run build

# Run offline Depth Anything V2 + OpenCV perception on a screenshot
bun run perceive /path/to/screenshot.jpg

# Run unit & integration tests across runtime, perception, and browsertool
bun test
```
