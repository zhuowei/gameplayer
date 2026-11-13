# Gameplay Agent Toolkit

Tools, browser runtime, and agent skills for playing **unmodified video games** strictly through **rendered video pixels** (`<canvas>` / `<video>`) and **virtual controller inputs** (`navigator.getGamepads()`).

## Architecture Overview

Driving a 30–60 Hz continuous game directly through a 0.1 Hz turn-based LLM tool loop fails due to inference latency, open-loop drift, and video-transcoding overhead. This repository implements a **two-loop + annotated contact-sheet** stack for browser game streaming clients (MoonlightWeb, Xbox Cloud/Remote Play):

1. **[packages/runtime](packages/runtime/README.md) (`window.gameplayApi` `3.0.0`)**
   - Overrides `navigator.getGamepads()` with an Xbox-standard 17-button, 4-axis virtual controller (`BTN`, `setButton`, `tapButton`, `setStick`, `pulseStick`, `rampStick`, `resetAll`).
   - **System 1 (`driveServo`)**: 30 Hz closed-loop multi-cue pixel analysis (desert sand & vertical wall rejection, kart-safe non-poisoning road model, thresholded column centroid, curvature-coupled throttle modulation, and outlined `WRONG WAY!` detection) + PD steering controller.
   - **System 2 (`runChunk` & `smartRescue`)**: Pause-bounded scripted maneuvers wrapped in `try / finally` so exceptions or API timeouts never leave buttons stuck or the game silently unpaused.
   - **Pre-Pause Annotated Contact Sheets**: Samples active gameplay frames in memory, snapshots unobstructed full-resolution HUD crops (`MINIMAP`, `TUTORIAL PROMPT`, `LOOKAHEAD & ALERT`) *before* pausing, and renders a 4×2 timestamped grid—replacing slow `screencast_start` + `ffmpeg` `.mp4` workflows with a single JPEG screenshot.
2. **[packages/browsertool](packages/browsertool/README.md)**
   - Zero-dependency Bun CLI speaking raw Chrome DevTools Protocol (`ws://127.0.0.1:9222`) for environments outside network-isolated sandboxes (inside Antigravity's sandbox, use the native `chrome-devtools` MCP server instead).
3. **[skills/gameplay](skills/gameplay/SKILL.md) (Registered via [.agents/skills.json](.agents/skills.json))**
   - Progressive-disclosure agent skill covering runtime injection, pre-flight control calibration, `steerBias` & north-up minimap orientation rules, recovery discipline, and the [SuperTuxKart runbook](skills/gameplay/references/supertuxkart.md).

## Documentation & Post-Mortems

- **[AGENTS.md](AGENTS.md)**: Always-on workspace rules, sandbox/MCP conventions, and mandatory vision/control testing invariants.
- **[docs/lessons-learned.md](docs/lessons-learned.md)**: Quantitative comparison across four SuperTuxKart Tutorial runs (cutting rescues by 85% from `13` in v2 to `2` in v3, and trajectory steps from `918` → `494` → `348`), root-cause analysis of CV/control failure modes, and generalization roadmap across game genres and consoles.

## Quick Start

```sh
# Bundle packages/runtime/gameplay-runtime.js
bun run build

# Run unit tests across runtime and browsertool
bun test
```
