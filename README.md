# Gameplay Agent Toolkit

Tools, browser runtime, and agent skills for playing **unmodified video games** strictly through **rendered video pixels** (`<canvas>` / `<video>`) and **virtual controller inputs** (`navigator.getGamepads()`).

## Architecture Overview

Driving a 30–60 Hz continuous game directly through a 0.1 Hz turn-based LLM tool loop fails due to inference latency, open-loop drift, and video-transcoding overhead. This repository implements a **two-loop + annotated contact-sheet** stack for browser game streaming clients (MoonlightWeb, Xbox Cloud/Remote Play):

1. **[packages/runtime](packages/runtime/README.md) (`window.gameplayApi`)**
   - Overrides `navigator.getGamepads()` with an Xbox-standard 17-button, 4-axis virtual controller (`BTN`, `setButton`, `tapButton`, `setStick`, `rampStick`, `resetAll`).
   - **System 1 (`driveServo`)**: 30 Hz closed-loop pixel analysis + PD steering controller for straights and gentle curves, with stuck/alert early exits.
   - **System 2 (`runChunk` & `smartRescue`)**: Pause-bounded scripted maneuvers wrapped in `try / finally` so exceptions never leave buttons stuck or the game silently unpaused.
   - **Annotated Contact Sheets**: Samples active gameplay frames in memory and renders a 4×2 timestamped grid (with motion `%`, stick vectors, and active button pills) plus zoomed HUD crops—replacing multi-step `screencast_start` + `ffmpeg` `.mp4` workflows with a single fast JPEG screenshot.
2. **[packages/browsertool](packages/browsertool/README.md)**
   - Zero-dependency Bun CLI speaking raw Chrome DevTools Protocol (`ws://127.0.0.1:9222`) for environments outside network-isolated sandboxes (inside Antigravity's sandbox, use the native `chrome-devtools` MCP server instead).
3. **[skills/gameplay](skills/gameplay/SKILL.md) (Registered via [.agents/skills.json](.agents/skills.json))**
   - Progressive-disclosure agent skill covering runtime injection, pre-flight control calibration, north-up minimap orientation rules, recovery discipline, and the [SuperTuxKart runbook](skills/gameplay/references/supertuxkart.md).

## Documentation & Post-Mortems

- **[AGENTS.md](AGENTS.md)**: Always-on workspace rules, sandbox/MCP conventions, and mandatory vision/control testing invariants.
- **[docs/lessons-learned.md](docs/lessons-learned.md)**: Quantitative comparison across three SuperTuxKart Tutorial runs, root-cause analysis of off-road excursions and `smartRescue` overuse, Runtime v3 upgrade checklist, and generalization analysis across game genres and consoles.

## Quick Start

```sh
# Bundle packages/runtime/gameplay-runtime.js
bun run build

# Run unit tests across runtime and browsertool
bun test
```
