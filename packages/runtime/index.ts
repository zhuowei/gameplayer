import { BTN, createGamepadController } from "./src/gamepad";
import { createGameplayOrchestrator } from "./src/controller";
import { hideSheetOverlay } from "./src/vision";

const gamepad = createGamepadController();
const orchestrator = createGameplayOrchestrator(gamepad);

const gameplayApi = {
  version: "3.0.0",
  BTN,
  simGamepad: gamepad.simGamepad,
  setStick: gamepad.setStick,
  pulseStick: gamepad.pulseStick,
  setButton: gamepad.setButton,
  tapButton: gamepad.tapButton,
  rampStick: gamepad.rampStick,
  sleep: gamepad.sleep,
  resetAll: gamepad.resetAll,
  getState: gamepad.getState,
  dispatchConnected: gamepad.dispatchConnected,
  runChunk: orchestrator.runChunk,
  driveServo: orchestrator.driveServo,
  smartRescue: orchestrator.smartRescue,
  hideOverlay: hideSheetOverlay,
  inspectFrame: orchestrator.inspectFrame,
};

(window as unknown as Record<string, unknown>)["gameplayApi"] = gameplayApi;
console.log("Gameplay - hooked v3 (gamepad + multi-cue servo + pre-pause contact-sheet)");
