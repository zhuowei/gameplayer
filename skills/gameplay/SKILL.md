---
name: gameplay
description: Hierarchical two-loop + contact-sheet workflow for playing unmodified video games in Chrome streaming clients (MoonlightWeb, Xbox Cloud/Remote Play) via virtual gamepad and pixel-only observation.
---

# Gameplay Agent Skill (System 1 Servo + System 2 Contact Sheets)

Play games strictly through rendered video pixels (`<canvas>` / `<video>`) and virtual controller inputs (`window.gameplayApi`)—never modifying the game.

## Core Architecture: Two-Loop Control

Instead of driving frame-by-frame through slow open-loop sleeps or `screencast_start` + `ffmpeg` video transcodes:

1. **Inject `gameplay-runtime.js` once per page navigation:**
   - Via `chrome-devtools` MCP (`evaluate_script`): pass `sourcePath: "/Users/zhuowei/Documents/antigravity/gameplay/packages/runtime/gameplay-runtime.js"`, `format: "script"`.
   - Or via CLI: `bun run packages/browsertool/index.ts inject --match https://jane.local` (requires CDP port 9222).
   - Verify with `() => Boolean(window.gameplayApi)`.

2. **Start / Menus (Manual UI Calibration First):**
   - For menus, use `gameplayApi.hideOverlay()`, `gameplayApi.tapButton(idx)`, or `gameplayApi.setStick(0, x, y)` + `take_screenshot` (`format: "jpeg"`, `quality: 85`) + `read_file`.
   - Confirm whether the game menu uses Left Stick (`setStick(0, x, y)`) or D-pad (`BTN.DPAD_*`), and verify your Pause (`BTN.START = 9`), Unpause (`BTN.A = 0`), and Rescue (`BTN.BACK = 8`) buttons.
   - Note: `BTN` mapping is Xbox/Standard (`A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9`). In SuperTuxKart: `Y (3)` = Accelerate, `X (2)` = Brake/Reverse, `B (1)` = Fire Item, `LB (4)` = Nitro, `RB (5)` = Drift/Skid, `BACK (8)` = Rescue, `START (9)` = Pause.

3. **System 1 — Fast Local Visual Servo (`driveServo`) for Track & Path Following:**
   - On straights and visible curves, call:
     ```js
     async () => await gameplayApi.driveServo({ maxDurationMs: 2800, label: "seg-1" })
     ```
   - `driveServo` runs a **30 Hz pixel road-follower** with continuous throttle (held across unpause/pause), displays an **annotated 4×2 contact sheet + zoomed `FINAL MINIMAP` & `FINAL HUD / PROMPT` strip**, and auto-pauses early if `stuck`, `red_alert` (`WRONG WAY!`), or `low_confidence` occurs.
   - Pass `unpause: false` ONLY on the very first move after race start if the game is not yet paused; afterwards leave `unpause: true, pause: true` (default).
   - Use `steerBias` (e.g., `-0.2` left, `+0.2` right) to nudge lane preference when hugging an inside curve or picking up items/nitro bottles.

4. **System 2 — Deliberative Scripted Chunks (`runChunk`) for Special Actions:**
   - For sharp blind turns, firing items (`BTN.B`) at crates, activating nitro (`BTN.LB`), drifting (`BTN.RB`), or backing up cleanly, wrap inputs in `runChunk`:
     ```js
     async () => await gameplayApi.runChunk(async ({ api, shouldAbort }) => {
       await api.tapButton(api.BTN.B, 120, 150); // fire bowling ball
       await api.rampStick(0, -0.5, 0, 150);
       await api.sleep(700);
       await api.rampStick(0, 0, 0, 120);
     }, { holdGasButton: gameplayApi.BTN.Y, label: "clear-crates" })
     ```
   - `runChunk` guarantees `try/finally` button reset after pausing and shows the exact annotated contact sheet + motion `%` + stick vectors in a single `take_screenshot`.

5. **Inspecting After Each Step (1 Screenshot, Zero `ffmpeg`):**
   - Call `take_screenshot` (`format: "jpeg"`, `quality: 85`) and `read_file` on the saved image path.
   - Check the header telemetry (`stop=`, `avgΔ=`, `roadConf=`), the **cyan diamond** road target on each tile, the **yellow stick vector** corner indicator, and the **zoomed `FINAL MINIMAP` + `FINAL HUD / PROMPT`** strip at the bottom.

6. **Recovery Rules (Avoid Multi-Turn Loops):**
   - If `stopReason === "stuck"` or `"red_alert"`, or you are off-track / backwards, **do NOT spend >1 turn doing blind multi-point turns**—call `await gameplayApi.smartRescue()` immediately, or reverse straight (`BTN.X`, stick `(0, 0)`) first before turning!
   - Always trust the zoomed `FINAL MINIMAP` over blind hill crests.
