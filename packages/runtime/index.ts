/// implements a fake controller.

const gamepadAxes = [0, 0, 0, 0];
// standard mapping: https://adamjones.me/blog/gamepad-mapping/
const gamepadButtons: GamepadButton[] = Array.from({ length: 17 }, () => ({
  value: 0,
  pressed: false,
  touched: false,
}));
const simGamepad: Gamepad = {
  id: "Gameplay - SimGamepad",
  index: 0,
  connected: true,
  timestamp: 0,
  axes: gamepadAxes,
  buttons: gamepadButtons,
  vibrationActuator: undefined as unknown as GamepadHapticActuator,
  mapping: "standard",
};

const realGetGamepads = navigator.getGamepads;

function hookGetGamepads() {
  return [simGamepad];
}

navigator.getGamepads = hookGetGamepads;

window.addEventListener("load", () => {
  const event = new Event("gamepadconnected");
  (event as any)["gamepad"] = simGamepad;
  window.dispatchEvent(event);
});
console.log("Gameplay - hooked");

function updateGamepad() {
  (simGamepad.timestamp as number) = Date.now();
}

const gameplayApi = {
  setStick(index: number, x: number, y: number) {
    gamepadAxes[index * 2] = x;
    gamepadAxes[index * 2 + 1] = y;
    updateGamepad();
  },
  setButton(index: number, value: number) {
    const b = gamepadButtons[index];
    (b.value as number) = value;
    (b.pressed as boolean) = value > 0;
    updateGamepad();
  },
  async sleep(ms: number) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
  },
};

(window as any)["gameplayApi"] = gameplayApi;
