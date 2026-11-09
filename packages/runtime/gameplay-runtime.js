(() => {
  // index.ts
  var gamepadAxes = [0, 0, 0, 0];
  var gamepadButtons = Array.from({ length: 17 }, () => ({
    value: 0,
    pressed: false,
    touched: false
  }));
  var simGamepad = {
    id: "Gameplay - SimGamepad",
    index: 0,
    connected: true,
    timestamp: 0,
    axes: gamepadAxes,
    buttons: gamepadButtons,
    vibrationActuator: undefined,
    mapping: "standard"
  };
  var realGetGamepads = navigator.getGamepads;
  function hookGetGamepads() {
    return [simGamepad];
  }
  navigator.getGamepads = hookGetGamepads;
  window.addEventListener("load", () => {
    const event = new Event("gamepadconnected");
    event["gamepad"] = simGamepad;
    window.dispatchEvent(event);
  });
  console.log("Gameplay - hooked");
  function updateGamepad() {
    simGamepad.timestamp = Date.now();
  }
  var gameplayApi = {
    setStick(index, x, y) {
      if (index < 0 || index > gamepadAxes.length / 2) {
        throw new Error("Stick index out of bounds");
      }
      gamepadAxes[index * 2] = x;
      gamepadAxes[index * 2 + 1] = y;
      updateGamepad();
    },
    setButton(index, value) {
      if (index < 0 || index >= gamepadButtons.length) {
        throw new Error("Button index out of bounds");
      }
      const b = gamepadButtons[index];
      b.value = value;
      b.pressed = value > 0;
      updateGamepad();
    },
    async sleep(ms) {
      await new Promise((resolve) => {
        setTimeout(resolve, ms);
      });
    }
  };
  window["gameplayApi"] = gameplayApi;
})();
