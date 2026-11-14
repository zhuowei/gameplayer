# Gameplay Agent Workspace Guidelines (`AGENTS.md`)

## Black-Box Constraint
- Treat every target game strictly as an unmodified black box:
  - **Inputs**: Virtual controller state (`navigator.getGamepads()` via `window.gameplayApi`) or hardware/stream controller packets.
  - **Outputs**: Rendered video frames (`<canvas>` / `<video>`) and audio.
- Never patch game binaries, read game memory, or query internal engine state.

## Repository Structure & Commands
- `packages/runtime/`: Injected browser runtime (`window.gameplayApi` `v5.0.1`) providing virtual Xbox-layout gamepad control, 30 Hz biome-agnostic Pure-Pursuit pixel servoing (`driveServo`, default `7000ms` adaptive horizon), non-blocking `280×210` Depth Anything V2 Small Web Worker inference (`initDepthEngine` / `getDepthStatus`), 30 Hz temporal minimap odometry (`MinimapTracker` with bounded-width cobblestone stroke filtering), local `autoUnwedge` stuck recovery (including micro-jitter obstacle pinning), post-race finish detection (`stopOnRaceFinish`), safe scripted chunks (`runChunk`), rescue helpers (`smartRescue`), road-model reset (`resetRoadModel`), and annotated 4×2 contact-sheet overlays.
- `scripts/build-depth-bundle.ts`: Packages `onnxruntime-web` WASM + cached Depth Anything V2 Small weights into gitignored `.cache/gameplay-depth-bundle.js` during `bun run build`.
- `packages/perception/`: Offline third-party 3D depth & OpenCV analyzer CLI (`bun run perceive <screenshot.jpg>`) powered by quantized **Depth Anything V2 Small** (`@huggingface/transformers`), **OpenCV 5.0** (`@techstark/opencv-js`), and **`sharp`** (runs inside Standard Sandbox Mode with `BypassSandbox: false`).
- `packages/browsertool/`: Zero-dependency Bun CLI for raw Chrome DevTools Protocol (`ws://127.0.0.1:9222`) when running outside network-isolated sandboxes.
- `skills/gameplay/`: Progressive-disclosure gameplay skill ([SKILL.md](skills/gameplay/SKILL.md)) and game-specific runbooks ([supertuxkart.md](skills/gameplay/references/supertuxkart.md)).
- `docs/lessons-learned.md`: Empirical post-mortem across six SuperTuxKart runs (four Tutorial iterations + Run 5 zero-shot *Antediluvian Abyss* + Run 6 zero-shot *Blackhill Mansion* & `v5.0.1` fixes) plus cross-game Tier-3 evaluation (*Fortnite: Save the World* on `play.xbox.com`), causal attribution, step-sizing analysis, real-time loop tradeoffs, and foundation-model caveats.

Build and test inside the standard sandbox before committing:
```sh
bun run build
bun test
```

## Antigravity Sandbox & Browser Tooling Rules
1. **Prefer `chrome-devtools` MCP inside Antigravity**:
   - MCP tools (`list_pages`, `evaluate_script`, `take_screenshot`) work inside the standard sandbox without `BypassSandbox: true`.
   - `packages/browsertool` connects to `127.0.0.1:9222` over WebSocket, which is blocked in network-isolated sandboxes unless `BypassSandbox: true` is used.
2. **Runtime injection (`sourcePath` when `--workspace` is configured, else inline) & screenshot paths**:
   - When `chrome-devtools` MCP has `--workspace /Users/zhuowei/Documents/antigravity/gameplay` configured, inject `.cache/gameplay-depth-bundle.js` and `packages/runtime/gameplay-runtime.js` via `evaluate_script` with `sourcePath` and `format: "script"` (zero LLM context tokens). If `workspaceRoots` is unconfigured, fall back to passing `packages/runtime/gameplay-runtime.js` inline via `function` with `format: "script"`. Omit `take_screenshot` `filePath` and read the auto-saved screenshot path returned by `take_screenshot`.
3. **Never use `screencast_start` + `ffmpeg` slow-motion loops for turn-by-turn control**:
   - Recording `.mp4` chunks and re-encoding via `ffmpeg` adds 25–75s latency per move and bloats multimodal context. Use `gameplayApi`'s in-canvas contact-sheet overlay + a single JPEG `take_screenshot` (`quality: 85`).
4. **Never disable browser CSP (`--disable-web-security` / `setBypassCSP`) via MCP or agent flags**:
   - Strict-CSP portals (e.g., `play.xbox.com`) block `onnxruntime-web` WASM/`Blob` Workers, whereas `packages/runtime/gameplay-runtime.js` via CDP `evaluate_script` already runs cleanly. Skip injecting `.cache/gameplay-depth-bundle.js` on those domains and use sandboxed host `bun run perceive` (`518×518` Depth Anything V2 + OpenCV) by default—or ask the user to manually enable a site-scoped Chrome extension that disables CSP on that origin if in-page WASM (`initDepthEngine()`) or CSP-blocked scripting is needed.

## Critical Control, Vision & Testing Invariants
1. **State cleanup in `try / finally`**:
   - Every multi-step input sequence must pause (when operating pause-bounded) and call `resetAll()` inside `finally` so runtime exceptions never leave throttle, brake, or drift buttons latched.
2. **Capture HUD / minimap crops *before* pausing**:
   - Many games (including SuperTuxKart) hide or occlude the HUD/minimap as soon as the Pause overlay opens. Any `FINAL MINIMAP` or `FINAL HUD` crop must come from the last *unpaused* active frame, never from the post-pause surface.
3. **Verify pause-menu button edge semantics**:
   - Do not assume holding throttle *before* dismissing a pause menu preserves momentum; SuperTuxKart ignores pre-held throttle (`BTN.Y`) until a fresh press occurs *after* `BTN.A` closes the pause dialog (`>= 220ms` settle).
4. **Guard pixel heuristics against false-high confidence & self-poisoning**:
   - Never rely on permissive RGB similarity or unthresholded column centroids (`w = s^2`) without negative-class tests (e.g., sand shoulders, sunlit rock/plaster walls, player sprite occlusion).
   - Never adapt an online road-color EMA blindly when off-center or low-confidence, or the model will learn that off-road terrain *is* the road.
   - Couple steering demand to speed/throttle modulation on tight curves (`>= 60°`); full-throttle turning radii exceed narrow corners in most racing games.
5. **Test documented snippets verbatim**:
   - Whenever adding or editing code examples in `skills/gameplay/SKILL.md`, add or update a test in `packages/runtime/src/runtime.test.ts` that exercises the exact callback/API shape (e.g., `ctx.api.BTN`) so documentation/code drift fails `bun test`.
6. **Evaluate driving quality and verify genuine completion**:
   - Track **off-road excursions** and **`smartRescue()` / auto-rescue counts** alongside wall-clock time and step count. Treating rescue teleports as routine navigation masks control bugs; a healthy SuperTuxKart tutorial lap should require **0–1 rescues**.
   - Never declare a race finished from static minimap proximity (e.g., figure-8 overpass/underpass intersections), the `1/1` lap HUD icon, or AI opponents' checkered flags; require the player's own checkered flag, `"You finished the race"` banner, or post-race results scoreboard.
