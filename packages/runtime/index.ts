import { BTN, createGamepadController } from "./src/gamepad";
import { createGameplayOrchestrator } from "./src/controller";
import { hideSheetOverlay } from "./src/vision";

const gamepad = createGamepadController();
const orchestrator = createGameplayOrchestrator(gamepad);

const gameplayApi = {
  version: "5.0.0",
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
  resetRoadModel: orchestrator.resetRoadModel,
  initDepthEngine: orchestrator.initDepthEngine,
  getDepthStatus: orchestrator.getDepthStatus,
  inspectFrame: orchestrator.inspectFrame,
};

(window as unknown as Record<string, unknown>)["gameplayApi"] = gameplayApi;
console.log(
  "Gameplay - hooked v5 (in-page 3D depth worker + 30Hz minimap odometry + autoUnwedge + finish detection)",
);
