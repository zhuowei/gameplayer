# Gameplay Agent Toolkit

Tools, browser runtime, third-party 3D depth/OpenCV perception, and agent skills for playing **unmodified video games** strictly through **rendered video pixels** (`<canvas>` / `<video>`) and **virtual controller inputs** (`navigator.getGamepads()`).

## Architecture Overview

Driving a 30–60 Hz continuous game directly through a 0.1 Hz turn-based LLM tool loop fails due to inference latency, open-loop drift, and video-transcoding overhead. This repository implements a **two-loop + pretrained 3D depth/OpenCV + annotated contact-sheet** stack for browser game streaming clients (MoonlightWeb, Xbox Cloud/Remote Play):

1. **[packages/runtime](packages/runtime/README.md) (`window.gameplayApi` `4.0.0`)**
   - Overrides `navigator.getGamepads()` with an Xbox-standard 17-button, 4-axis virtual controller (`BTN`, `setButton`, `tapButton`, `setStick`, `pulseStick`, `rampStick`, `resetAll`).
   - **System 1 (`driveServo` v4)**: 30 Hz closed-loop biome-agnostic pixel analysis (supports asphalt, dirt, stone, wood, moss, and bright snow/ice; online contrastive off-road shoulder learning; mode-seeking contiguous corridor selection; Pure-Pursuit dual-band curvature lookahead + auto corner braking; optional `depthSteerHint`; and `WRONG WAY!` detection) + PD steering controller.
   - **System 2 (`runChunk`, `smartRescue`, `resetRoadModel`)**: Pause-bounded scripted maneuvers wrapped in `try / finally` so exceptions never leave inputs latched.
   - **Pre-Pause Annotated Contact Sheets**: Captures unobstructed full-resolution HUD crops (`MINIMAP`, `TUTORIAL PROMPT`, `LOOKAHEAD & ALERT`) *before* pausing and renders a deterministic 4×2 timestamped grid for single-JPEG inspection.
2. **[packages/perception](packages/perception/index.ts) (`bun run perceive`)**
   - Offline host-side 3D & geometric perception CLI (~400 ms inside Standard Sandbox Mode with zero network access) powered by **quantized Depth Anything V2 Small** (`@huggingface/transformers` + `onnxruntime-node`), **OpenCV 5.0** (`@techstark/opencv-js` Canny/Hough vanishing point + Difference-of-Gaussians minimap ribbon & ego-heading curvature), and **`sharp`**.
3. **[packages/browsertool](packages/browsertool/README.md)**
   - Zero-dependency Bun CLI speaking raw Chrome DevTools Protocol (`ws://127.0.0.1:9222`) for environments outside network-isolated sandboxes (inside Antigravity's sandbox, use the native `chrome-devtools` MCP server instead).
4. **[skills/gameplay](skills/gameplay/SKILL.md) (Registered via [.agents/skills.json](.agents/skills.json))**
   - Progressive-disclosure agent skill covering runtime v4 injection, `bun run perceive` 3D depth/OpenCV integration, zero-shot unseen track protocol, recovery discipline, and the [SuperTuxKart runbook](skills/gameplay/references/supertuxkart.md).

## Documentation & Post-Mortems

- **[AGENTS.md](AGENTS.md)**: Always-on workspace rules, sandbox/MCP conventions, and mandatory vision/control testing invariants.
- **[docs/lessons-learned.md](docs/lessons-learned.md)**: Quantitative comparison across four SuperTuxKart Tutorial runs (cutting rescues by 85% from `13` in v2 to `2` in v3, and trajectory steps from `918` → `494` → `348`), causal attribution across tools/docs/model tiers, third-party library tradeoffs, and foundation-model caveats (NitroGen, SIMA 2).

## Quick Start

```sh
# Bundle packages/runtime/gameplay-runtime.js (v4.0.0)
bun run build

# Run offline Depth Anything V2 + OpenCV perception on a screenshot
bun run perceive /path/to/screenshot.jpg

# Run unit & integration tests across runtime, perception, and browsertool
bun test
```
