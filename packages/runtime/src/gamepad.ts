import type { GamepadSnapshot } from "./types";

export const BTN = {
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  BACK: 8,
  START: 9,
  L3: 10,
  R3: 11,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15,
  HOME: 16,
} as const;

export function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

export interface GamepadController {
  BTN: typeof BTN;
  simGamepad: Gamepad;
  setStick(index: number, x: number, y: number): void;
  pulseStick(
    index: number,
    x: number,
    y: number,
    holdMs?: number,
    settleMs?: number,
  ): Promise<void>;
  setButton(index: number, value: number): void;
  tapButton(index: number, durationMs?: number, settleMs?: number): Promise<void>;
  rampStick(
    index: number,
    targetX: number,
    targetY: number,
    durationMs?: number,
    steps?: number,
  ): Promise<void>;
  sleep(ms: number): Promise<void>;
  resetAll(): void;
  getState(): GamepadSnapshot;
  dispatchConnected(): void;
}

function adoptPrototypeSafely<T extends object>(obj: T, ctor: unknown): T {
  if (typeof ctor !== "function" || !ctor.prototype) {
    return obj;
  }
  const proto = ctor.prototype as object;
  const descriptors = Object.getOwnPropertyDescriptors(proto);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (key === "constructor") continue;
    const desc = (descriptors as Record<PropertyKey, PropertyDescriptor>)[key];
    if (
      desc &&
      typeof desc.get === "function" &&
      !Object.prototype.hasOwnProperty.call(obj, key)
    ) {
      // Shadow Blink WebIDL prototype getters with null data properties so enumeration never throws Illegal invocation.
      Object.defineProperty(obj, key, {
        value: null,
        writable: true,
        enumerable: desc.enumerable ?? true,
        configurable: true,
      });
    }
  }
  try {
    Object.setPrototypeOf(obj, proto);
  } catch {
    // Ignore non-extensible or sealed targets
  }
  return obj;
}

/**
 * Installs a deterministic virtual standard gamepad by overriding navigator.getGamepads
 * and dispatching `gamepadconnected` immediately when injected post-load.
 */
export function createGamepadController(
  targetWindow: Window & typeof globalThis = window,
  targetNavigator: Navigator = navigator,
  targetDocument: Document | undefined = typeof document !== "undefined" ? document : undefined,
): GamepadController {
  const winRecord = targetWindow as unknown as Record<string, unknown>;

  function nowTimestamp(): number {
    const perf = winRecord.performance as Performance | undefined;
    return typeof perf?.now === "function" ? perf.now() : Date.now();
  }

  const gamepadAxes = [0, 0, 0, 0];
  const gamepadButtons: GamepadButton[] = Array.from({ length: 17 }, () =>
    adoptPrototypeSafely(
      {
        value: 0,
        pressed: false,
        touched: false,
      } as GamepadButton,
      winRecord.GamepadButton,
    ),
  );

  const simGamepad: Gamepad = adoptPrototypeSafely(
    {
      id: "Gameplay - SimGamepad",
      index: 0,
      connected: true,
      timestamp: nowTimestamp(),
      axes: gamepadAxes,
      buttons: gamepadButtons,
      vibrationActuator: null as unknown as GamepadHapticActuator,
      mapping: "standard",
    } as Gamepad,
    winRecord.Gamepad,
  );

  function hookGetGamepads(): (Gamepad | null)[] {
    return [simGamepad, null, null, null];
  }

  try {
    targetNavigator.getGamepads = hookGetGamepads;
  } catch {
    Object.defineProperty(targetNavigator, "getGamepads", {
      value: hookGetGamepads,
      configurable: true,
      writable: true,
    });
  }

  function updateGamepad(): void {
    (simGamepad as { timestamp: number }).timestamp = nowTimestamp();
  }

  function dispatchConnected(): void {
    const event = new Event("gamepadconnected") as Event & { gamepad: Gamepad };
    Object.defineProperty(event, "gamepad", {
      value: simGamepad,
      enumerable: true,
      configurable: true,
    });
    adoptPrototypeSafely(event, winRecord.GamepadEvent);
    targetWindow.dispatchEvent(event);
  }

  if (targetDocument && targetDocument.readyState !== "loading") {
    dispatchConnected();
  } else {
    targetWindow.addEventListener("load", dispatchConnected, { once: true });
  }

  function sleep(ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      targetWindow.setTimeout(resolve, ms);
    });
  }

  function resolveStickIndex(index: number | "left" | "right"): number {
    const idx = index === "left" ? 0 : index === "right" ? 1 : index;
    if (
      typeof idx !== "number" ||
      !Number.isInteger(idx) ||
      idx < 0 ||
      idx >= gamepadAxes.length / 2
    ) {
      throw new Error(`Stick index out of bounds: ${index}`);
    }
    return idx;
  }

  function setStick(
    index: number | "left" | "right",
    x: number,
    y: number,
  ): void {
    const idx = resolveStickIndex(index);
    gamepadAxes[idx * 2] = clamp(x, -1, 1);
    gamepadAxes[idx * 2 + 1] = clamp(y, -1, 1);
    updateGamepad();
  }

  function setButton(index: number, value: number): void {
    if (index < 0 || index >= gamepadButtons.length) {
      throw new Error(`Button index out of bounds: ${index}`);
    }
    const clamped = clamp(value, 0, 1);
    const b = gamepadButtons[index] as {
      value: number;
      pressed: boolean;
      touched: boolean;
    };
    b.value = clamped;
    b.pressed = clamped > 0.05;
    b.touched = clamped > 0;
    updateGamepad();
  }

  async function tapButton(
    index: number,
    durationMs = 100,
    settleMs = 50,
  ): Promise<void> {
    setButton(index, 1);
    await sleep(durationMs);
    setButton(index, 0);
    await sleep(settleMs);
  }

  async function pulseStick(
    index: number | "left" | "right",
    x: number,
    y: number,
    holdMs = 150,
    settleMs = 160,
  ): Promise<void> {
    const idx = resolveStickIndex(index);
    try {
      setStick(idx, x, y);
      await sleep(holdMs);
    } finally {
      setStick(index, 0, 0);
    }
    if (settleMs > 0) {
      await sleep(settleMs);
    }
  }

  async function rampStick(
    index: number,
    targetX: number,
    targetY: number,
    durationMs = 150,
    steps = 8,
  ): Promise<void> {
    if (index < 0 || index >= gamepadAxes.length / 2) {
      throw new Error(`Stick index out of bounds: ${index}`);
    }
    const startX = gamepadAxes[index * 2];
    const startY = gamepadAxes[index * 2 + 1];
    const clampedTargetX = clamp(targetX, -1, 1);
    const clampedTargetY = clamp(targetY, -1, 1);

    if (durationMs <= 0 || steps <= 1) {
      setStick(index, clampedTargetX, clampedTargetY);
      return;
    }

    const stepMs = durationMs / steps;
    for (let i = 1; i <= steps; i++) {
      const alpha = i / steps;
      setStick(
        index,
        startX + (clampedTargetX - startX) * alpha,
        startY + (clampedTargetY - startY) * alpha,
      );
      await sleep(stepMs);
    }
  }

  function resetAll(): void {
    for (let i = 0; i < gamepadAxes.length; i++) {
      gamepadAxes[i] = 0;
    }
    for (const btn of gamepadButtons) {
      const b = btn as { value: number; pressed: boolean; touched: boolean };
      b.value = 0;
      b.pressed = false;
      b.touched = false;
    }
    updateGamepad();
  }

  function getState(): GamepadSnapshot {
    return {
      axes: [...gamepadAxes],
      buttons: gamepadButtons.map((b) => b.value),
      timestamp: simGamepad.timestamp,
    };
  }

  return {
    BTN,
    simGamepad,
    setStick,
    pulseStick,
    setButton,
    tapButton,
    rampStick,
    sleep,
    resetAll,
    getState,
    dispatchConnected,
  };
}
