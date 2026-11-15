(() => {
  // packages/runtime/src/gamepad.ts
  var BTN = {
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
    HOME: 16
  };
  function clamp(val, min, max) {
    return Math.max(min, Math.min(max, val));
  }
  function adoptPrototypeSafely(obj, ctor) {
    if (typeof ctor !== "function" || !ctor.prototype) {
      return obj;
    }
    const proto = ctor.prototype;
    const descriptors = Object.getOwnPropertyDescriptors(proto);
    for (const key of Reflect.ownKeys(descriptors)) {
      if (key === "constructor")
        continue;
      const desc = descriptors[key];
      if (desc && typeof desc.get === "function" && !Object.prototype.hasOwnProperty.call(obj, key)) {
        Object.defineProperty(obj, key, {
          value: null,
          writable: true,
          enumerable: desc.enumerable ?? true,
          configurable: true
        });
      }
    }
    try {
      Object.setPrototypeOf(obj, proto);
    } catch {}
    return obj;
  }
  function createGamepadController(targetWindow = window, targetNavigator = navigator, targetDocument = typeof document !== "undefined" ? document : undefined) {
    const winRecord = targetWindow;
    function nowTimestamp() {
      const perf = winRecord.performance;
      return typeof perf?.now === "function" ? perf.now() : Date.now();
    }
    const gamepadAxes = [0, 0, 0, 0];
    const gamepadButtons = Array.from({ length: 17 }, () => adoptPrototypeSafely({
      value: 0,
      pressed: false,
      touched: false
    }, winRecord.GamepadButton));
    const simGamepad = adoptPrototypeSafely({
      id: "Gameplay - SimGamepad",
      index: 0,
      connected: true,
      timestamp: nowTimestamp(),
      axes: gamepadAxes,
      buttons: gamepadButtons,
      vibrationActuator: null,
      mapping: "standard"
    }, winRecord.Gamepad);
    function hookGetGamepads() {
      return [simGamepad, null, null, null];
    }
    try {
      targetNavigator.getGamepads = hookGetGamepads;
    } catch {
      Object.defineProperty(targetNavigator, "getGamepads", {
        value: hookGetGamepads,
        configurable: true,
        writable: true
      });
    }
    function updateGamepad() {
      simGamepad.timestamp = nowTimestamp();
    }
    function dispatchConnected() {
      const event = new Event("gamepadconnected");
      Object.defineProperty(event, "gamepad", {
        value: simGamepad,
        enumerable: true,
        configurable: true
      });
      adoptPrototypeSafely(event, winRecord.GamepadEvent);
      targetWindow.dispatchEvent(event);
    }
    if (targetDocument && targetDocument.readyState !== "loading") {
      dispatchConnected();
    } else {
      targetWindow.addEventListener("load", dispatchConnected, { once: true });
    }
    function sleep(ms) {
      if (ms <= 0)
        return Promise.resolve();
      return new Promise((resolve) => {
        targetWindow.setTimeout(resolve, ms);
      });
    }
    function setStick(index, x, y) {
      if (index < 0 || index >= gamepadAxes.length / 2) {
        throw new Error(`Stick index out of bounds: ${index}`);
      }
      gamepadAxes[index * 2] = clamp(x, -1, 1);
      gamepadAxes[index * 2 + 1] = clamp(y, -1, 1);
      updateGamepad();
    }
    function setButton(index, value) {
      if (index < 0 || index >= gamepadButtons.length) {
        throw new Error(`Button index out of bounds: ${index}`);
      }
      const clamped = clamp(value, 0, 1);
      const b = gamepadButtons[index];
      b.value = clamped;
      b.pressed = clamped > 0.05;
      b.touched = clamped > 0;
      updateGamepad();
    }
    async function tapButton(index, durationMs = 100, settleMs = 50) {
      setButton(index, 1);
      await sleep(durationMs);
      setButton(index, 0);
      await sleep(settleMs);
    }
    async function pulseStick(index, x, y, holdMs = 150, settleMs = 160) {
      if (index < 0 || index >= gamepadAxes.length / 2) {
        throw new Error(`Stick index out of bounds: ${index}`);
      }
      try {
        setStick(index, x, y);
        await sleep(holdMs);
      } finally {
        setStick(index, 0, 0);
      }
      if (settleMs > 0) {
        await sleep(settleMs);
      }
    }
    async function rampStick(index, targetX, targetY, durationMs = 150, steps = 8) {
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
      for (let i = 1;i <= steps; i++) {
        const alpha = i / steps;
        setStick(index, startX + (clampedTargetX - startX) * alpha, startY + (clampedTargetY - startY) * alpha);
        await sleep(stepMs);
      }
    }
    function resetAll() {
      for (let i = 0;i < gamepadAxes.length; i++) {
        gamepadAxes[i] = 0;
      }
      for (const btn of gamepadButtons) {
        const b = btn;
        b.value = 0;
        b.pressed = false;
        b.touched = false;
      }
      updateGamepad();
    }
    function getState() {
      return {
        axes: [...gamepadAxes],
        buttons: gamepadButtons.map((b) => b.value),
        timestamp: simGamepad.timestamp
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
      dispatchConnected
    };
  }

  // packages/runtime/src/depth.ts
  var DEFAULT_WIDTH = 280;
  var DEFAULT_HEIGHT = 210;
  var IMAGENET_MEAN = [0.485, 0.456, 0.406];
  var IMAGENET_STD = [0.229, 0.224, 0.225];
  function rgbaToNormalizedChwTensor(rgba, w, h) {
    const planeSize = w * h;
    const out = new Float32Array(3 * planeSize);
    const inv255 = 1 / 255;
    const invStdR = 1 / IMAGENET_STD[0];
    const invStdG = 1 / IMAGENET_STD[1];
    const invStdB = 1 / IMAGENET_STD[2];
    for (let i = 0;i < planeSize; i++) {
      const p = i * 4;
      out[i] = (rgba[p] * inv255 - IMAGENET_MEAN[0]) * invStdR;
      out[planeSize + i] = (rgba[p + 1] * inv255 - IMAGENET_MEAN[1]) * invStdG;
      out[2 * planeSize + i] = (rgba[p + 2] * inv255 - IMAGENET_MEAN[2]) * invStdB;
    }
    return out;
  }
  function analyzeDisparityMap(disparity, dw, dh) {
    const numSectors = 7;
    const rawSectorDisp = new Float64Array(numSectors);
    const y0 = Math.max(0, Math.floor(dh * 0.28));
    const y1 = Math.max(y0 + 1, Math.floor(dh * 0.46));
    const xMargin = Math.floor(dw * 0.05);
    const spanW = dw - 2 * xMargin;
    for (let s = 0;s < numSectors; s++) {
      const sx0 = xMargin + Math.floor(s / numSectors * spanW);
      const sx1 = Math.max(sx0 + 1, xMargin + Math.floor((s + 1) / numSectors * spanW));
      const vals = [];
      for (let y = y0;y < y1; y++) {
        for (let x = sx0;x < sx1; x++) {
          vals.push(disparity[y * dw + x]);
        }
      }
      vals.sort((a, b) => a - b);
      const p88 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.88))] ?? 0;
      rawSectorDisp[s] = p88;
    }
    let nearSum = 0;
    let nearCnt = 0;
    for (let y = Math.floor(dh * 0.72);y < Math.floor(dh * 0.84); y++) {
      for (let x = Math.floor(dw * 0.25);x < Math.floor(dw * 0.75); x++) {
        const xf = x / dw;
        if (xf > 0.38 && xf < 0.62)
          continue;
        nearSum += disparity[y * dw + x];
        nearCnt++;
      }
    }
    const nearGroundDisp = nearCnt > 0 ? nearSum / nearCnt : 4.5;
    const skyVals = [];
    for (let y = Math.floor(dh * 0.16);y < Math.floor(dh * 0.32); y += 2) {
      for (let x = xMargin;x < dw - xMargin; x += 2) {
        skyVals.push(disparity[y * dw + x]);
      }
    }
    skyVals.sort((a, b) => a - b);
    const farRefDisp = skyVals[Math.floor(skyVals.length * 0.15)] ?? 0.2;
    const dispRange = Math.max(0.8, nearGroundDisp - farRefDisp);
    const sectorClearanceLtoR = [];
    for (let s = 0;s < numSectors; s++) {
      const normDisp = (rawSectorDisp[s] - farRefDisp) / dispRange;
      const clearance = Math.max(0, Math.min(1, 1 - normDisp * 1.45));
      sectorClearanceLtoR.push(Number(clearance.toFixed(3)));
    }
    const maxClearance = Math.max(...sectorClearanceLtoR);
    const centerClearance = sectorClearanceLtoR[3];
    const floorThresh = Math.max(0.18, maxClearance - 0.16);
    let bestRunScore = -1;
    let bestCorridorX = 0;
    let sIdx = 0;
    while (sIdx < numSectors) {
      if (sectorClearanceLtoR[sIdx] < floorThresh) {
        sIdx++;
        continue;
      }
      let runEnd = sIdx;
      let wSum = 0;
      let wxSum = 0;
      let runScore = 0;
      while (runEnd < numSectors && sectorClearanceLtoR[runEnd] >= floorThresh) {
        const cVal = sectorClearanceLtoR[runEnd];
        const excess = cVal - floorThresh + 0.05;
        const normX = (runEnd + 0.5) / numSectors * 2 - 1;
        const w = excess * excess;
        wSum += w;
        wxSum += w * normX;
        runScore += cVal * cVal * (1 - 0.12 * Math.abs(normX));
        runEnd++;
      }
      if (runScore > bestRunScore && wSum > 0.000001) {
        bestRunScore = runScore;
        bestCorridorX = wxSum / wSum;
      }
      sIdx = runEnd;
    }
    const corridorOffsetX = Number(bestCorridorX.toFixed(3));
    const wallOrObstacleAhead = maxClearance < 0.45 || centerClearance < maxClearance - 0.12 && Math.abs(corridorOffsetX) >= 0.22;
    return {
      corridorOffsetX,
      centerClearance,
      maxClearance: Number(maxClearance.toFixed(3)),
      wallOrObstacleAhead,
      sectorClearanceLtoR
    };
  }
  function decodeBase64ToUint8Array(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0;i < bin.length; i++) {
      bytes[i] = bin.charCodeAt(i);
    }
    return bytes;
  }
  var WORKER_TAIL_SCRIPT = `
let __session = null;
self.onmessage = async (ev) => {
  const msg = ev.data;
  if (!msg || !msg.type) return;
  if (msg.type === "init") {
    try {
      const ort = self.ort;
      if (!ort) throw new Error("ORT global missing in depth worker");
      ort.env.wasm.numThreads = 1;
      ort.env.wasm.proxy = false;
      ort.env.wasm.wasmBinary = new Uint8Array(msg.wasmBuffer);
      __session = await ort.InferenceSession.create(new Uint8Array(msg.modelBuffer), {
        executionProviders: ["wasm"],
      });
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "init_error", message: String(err && err.message ? err.message : err) });
    }
    return;
  }
  if (msg.type === "infer") {
    try {
      if (!__session) throw new Error("Depth session not initialized");
      const ort = self.ort;
      const t0 = performance.now();
      const inputName = __session.inputNames[0];
      const outputName = __session.outputNames[0];
      const tensor = new ort.Tensor("float32", new Float32Array(msg.chwBuffer), [1, 3, msg.height, msg.width]);
      const outMap = await __session.run({ [inputName]: tensor });
      const outTensor = outMap[outputName];
      const dims = outTensor.dims;
      const dh = dims.length === 3 ? dims[1] : dims[0];
      const dw = dims.length === 3 ? dims[2] : dims[1];
      const copy = new Float32Array(outTensor.data);
      const inferMs = performance.now() - t0;
      self.postMessage(
        { type: "result", id: msg.id, dispBuffer: copy.buffer, dw, dh, inferMs },
        [copy.buffer],
      );
    } catch (err) {
      self.postMessage({
        type: "infer_error",
        id: msg.id,
        message: String(err && err.message ? err.message : err),
      });
    }
  }
};
`;

  class BrowserDepthEngine {
    scratchCanvas = null;
    scratchCtx = null;
    status = {
      ready: false,
      mode: "uninitialized",
      inputSize: [DEFAULT_WIDTH, DEFAULT_HEIGHT],
      inferencesCompleted: 0,
      lastInferMs: 0,
      lastResult: null
    };
    initPromise = null;
    busy = false;
    lastSubmitAt = -Infinity;
    nextReqId = 1;
    workerPending = new Map;
    getGlobalStore() {
      return typeof window !== "undefined" ? window : globalThis;
    }
    getDecodedAssets() {
      const g = this.getGlobalStore();
      const existing = g.__gameplayDepthDecoded;
      if (existing && existing.wasmBytes?.byteLength > 0 && existing.modelBytes?.byteLength > 0) {
        return existing;
      }
      const raw = g.__gameplayDepthAssets;
      if (!raw || !raw.ortIifeJs || !raw.wasmBase64 || !raw.modelBase64) {
        return null;
      }
      const inputWidth = Math.max(DEFAULT_WIDTH, raw.inputWidth ?? DEFAULT_WIDTH);
      const inputHeight = Math.max(DEFAULT_HEIGHT, raw.inputHeight ?? DEFAULT_HEIGHT);
      const decoded = {
        ortIifeJs: raw.ortIifeJs,
        wasmBytes: decodeBase64ToUint8Array(raw.wasmBase64),
        modelBytes: decodeBase64ToUint8Array(raw.modelBase64),
        inputWidth,
        inputHeight
      };
      g.__gameplayDepthDecoded = decoded;
      raw.wasmBase64 = "";
      raw.modelBase64 = "";
      delete g.__gameplayDepthAssets;
      return decoded;
    }
    ensureScratchCanvas(w, h) {
      if (typeof document === "undefined")
        return null;
      if (!this.scratchCanvas) {
        this.scratchCanvas = document.createElement("canvas");
      }
      if (this.scratchCanvas.width !== w)
        this.scratchCanvas.width = w;
      if (this.scratchCanvas.height !== h)
        this.scratchCanvas.height = h;
      if (!this.scratchCtx) {
        this.scratchCtx = this.scratchCanvas.getContext("2d", {
          willReadFrequently: true
        });
      }
      return this.scratchCtx;
    }
    extractChw(surface) {
      const [w, h] = this.status.inputSize;
      const ctx = this.ensureScratchCanvas(w, h);
      if (!ctx)
        return null;
      ctx.drawImage(surface, 0, 0, w, h);
      const img = ctx.getImageData(0, 0, w, h);
      const chw = rgbaToNormalizedChwTensor(img.data, w, h);
      return { chw, width: w, height: h };
    }
    attachWorkerListener(worker) {
      worker.onmessage = (ev) => {
        const msg = ev.data;
        if (!msg || typeof msg !== "object")
          return;
        if (msg.type === "result") {
          const disp = new Float32Array(msg.dispBuffer);
          const parsed = analyzeDisparityMap(disp, msg.dw, msg.dh);
          const res = {
            ...parsed,
            inferMs: Number(msg.inferMs ?? 0),
            timestamp: performance.now()
          };
          this.busy = false;
          this.status.inferencesCompleted++;
          this.status.lastInferMs = res.inferMs;
          this.status.lastResult = res;
          const pending = this.workerPending.get(msg.id);
          if (pending) {
            this.workerPending.delete(msg.id);
            pending.resolve(res);
          }
        } else if (msg.type === "infer_error") {
          this.busy = false;
          this.status.error = String(msg.message ?? "Worker inference error");
          const pending = this.workerPending.get(msg.id);
          if (pending) {
            this.workerPending.delete(msg.id);
            pending.resolve(null);
          }
        }
      };
      worker.onerror = (err) => {
        this.busy = false;
        this.status.error = err.message || "Depth worker error";
        for (const [, p] of this.workerPending) {
          p.resolve(null);
        }
        this.workerPending.clear();
      };
    }
    getSingleton() {
      const s = this.getGlobalStore().__gameplayDepthSingleton;
      return s ?? null;
    }
    setSingleton(state) {
      this.getGlobalStore().__gameplayDepthSingleton = state;
    }
    async init() {
      if (this.status.ready)
        return this.getStatus();
      if (this.initPromise)
        return this.initPromise;
      const existingSingleton = this.getSingleton();
      if (existingSingleton && existingSingleton.ready) {
        this.status.mode = existingSingleton.mode;
        this.status.ready = true;
        this.status.inputSize = [
          existingSingleton.inputWidth,
          existingSingleton.inputHeight
        ];
        if (existingSingleton.worker) {
          this.attachWorkerListener(existingSingleton.worker);
        }
        return this.getStatus();
      }
      const decoded = this.getDecodedAssets();
      if (!decoded) {
        this.status.mode = "unavailable";
        this.status.ready = false;
        this.status.error = "No __gameplayDepthAssets bundle found; call evaluate_script with .cache/gameplay-depth-bundle.js first";
        return this.getStatus();
      }
      this.status.mode = "initializing";
      this.status.inputSize = [decoded.inputWidth, decoded.inputHeight];
      this.status.error = undefined;
      this.initPromise = (async () => {
        let workerError = "";
        if (typeof Worker !== "undefined" && typeof Blob !== "undefined") {
          try {
            const blob = new Blob([decoded.ortIifeJs, `
`, WORKER_TAIL_SCRIPT], {
              type: "application/javascript"
            });
            const blobUrl = URL.createObjectURL(blob);
            const worker = new Worker(blobUrl);
            await new Promise((resolve, reject) => {
              const timeoutId = setTimeout(() => {
                reject(new Error("Depth worker init timeout (8000ms)"));
              }, 8000);
              worker.onmessage = (ev) => {
                const m = ev.data;
                if (m?.type === "ready") {
                  clearTimeout(timeoutId);
                  resolve();
                } else if (m?.type === "init_error") {
                  clearTimeout(timeoutId);
                  reject(new Error(m.message || "Worker ORT init error"));
                }
              };
              worker.onerror = (err) => {
                clearTimeout(timeoutId);
                reject(new Error(err?.message || "Worker blocked or crashed on boot"));
              };
              const wasmCopy = decoded.wasmBytes.slice(0).buffer;
              const modelCopy = decoded.modelBytes.slice(0).buffer;
              worker.postMessage({
                type: "init",
                wasmBuffer: wasmCopy,
                modelBuffer: modelCopy
              }, [wasmCopy, modelCopy]);
            });
            URL.revokeObjectURL(blobUrl);
            this.attachWorkerListener(worker);
            this.status.mode = "worker";
            this.status.ready = true;
            this.status.error = undefined;
            this.setSingleton({
              worker,
              mainSession: null,
              ortRef: null,
              mode: "worker",
              ready: true,
              inputWidth: decoded.inputWidth,
              inputHeight: decoded.inputHeight
            });
            return this.getStatus();
          } catch (err) {
            workerError = err instanceof Error ? err.message : String(err);
          }
        } else {
          workerError = "Worker/Blob API unavailable";
        }
        try {
          const g = this.getGlobalStore();
          if (!g.ort) {
            new Function(decoded.ortIifeJs)();
          }
          const ort = g.ort;
          if (!ort) {
            throw new Error("Failed to evaluate ORT runtime on main thread");
          }
          ort.env.wasm.numThreads = 1;
          ort.env.wasm.proxy = false;
          ort.env.wasm.wasmBinary = decoded.wasmBytes.slice(0);
          const session = await ort.InferenceSession.create(decoded.modelBytes.slice(0), { executionProviders: ["wasm"] });
          this.status.mode = "main_thread";
          this.status.ready = true;
          this.status.error = workerError ? `worker_fallback: ${workerError}` : undefined;
          this.setSingleton({
            worker: null,
            mainSession: session,
            ortRef: ort,
            mode: "main_thread",
            ready: true,
            inputWidth: decoded.inputWidth,
            inputHeight: decoded.inputHeight,
            error: this.status.error
          });
          return this.getStatus();
        } catch (fallbackErr) {
          const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          this.status.mode = "error";
          this.status.ready = false;
          this.status.error = `worker=(${workerError}) main_thread=(${fbMsg})`;
          return this.getStatus();
        } finally {
          this.initPromise = null;
        }
      })();
      return this.initPromise;
    }
    getStatus() {
      return {
        ...this.status,
        inputSize: [...this.status.inputSize],
        lastResult: this.status.lastResult ? {
          ...this.status.lastResult,
          sectorClearanceLtoR: [
            ...this.status.lastResult.sectorClearanceLtoR
          ]
        } : null
      };
    }
    submitFrameNonBlocking(surface) {
      const singleton = this.getSingleton();
      if (this.status.ready && this.status.mode === "worker" && singleton?.worker && !this.busy) {
        const now = performance.now();
        if (now - this.lastSubmitAt >= 120) {
          const extracted = this.extractChw(surface);
          if (extracted) {
            this.busy = true;
            this.lastSubmitAt = now;
            const reqId = this.nextReqId++;
            singleton.worker.postMessage({
              type: "infer",
              id: reqId,
              chwBuffer: extracted.chw.buffer,
              width: extracted.width,
              height: extracted.height
            }, [extracted.chw.buffer]);
          }
        }
      }
      return this.status.lastResult;
    }
    async inferOnce(surface) {
      if (!this.status.ready) {
        await this.init();
      }
      const singleton = this.getSingleton();
      if (!this.status.ready || !singleton)
        return null;
      const extracted = this.extractChw(surface);
      if (!extracted)
        return null;
      if (this.status.mode === "worker" && singleton.worker) {
        if (this.busy) {
          return this.status.lastResult;
        }
        this.busy = true;
        this.lastSubmitAt = performance.now();
        const reqId = this.nextReqId++;
        return await new Promise((resolve) => {
          const timeoutId = setTimeout(() => {
            this.workerPending.delete(reqId);
            this.busy = false;
            resolve(this.status.lastResult);
          }, 4000);
          this.workerPending.set(reqId, {
            resolve: (res) => {
              clearTimeout(timeoutId);
              resolve(res);
            }
          });
          singleton.worker.postMessage({
            type: "infer",
            id: reqId,
            chwBuffer: extracted.chw.buffer,
            width: extracted.width,
            height: extracted.height
          }, [extracted.chw.buffer]);
        });
      }
      if (this.status.mode === "main_thread" && singleton.mainSession && singleton.ortRef) {
        if (this.busy)
          return this.status.lastResult;
        this.busy = true;
        try {
          const t0 = performance.now();
          const sess = singleton.mainSession;
          const ort = singleton.ortRef;
          const tensor = new ort.Tensor("float32", extracted.chw, [
            1,
            3,
            extracted.height,
            extracted.width
          ]);
          const outMap = await sess.run({ [sess.inputNames[0]]: tensor });
          const outTensor = outMap[sess.outputNames[0]];
          const dims = outTensor.dims;
          const dh = dims.length === 3 ? dims[1] : dims[0];
          const dw = dims.length === 3 ? dims[2] : dims[1];
          const parsed = analyzeDisparityMap(outTensor.data, dw, dh);
          const inferMs = performance.now() - t0;
          const res = {
            ...parsed,
            inferMs,
            timestamp: performance.now()
          };
          this.status.inferencesCompleted++;
          this.status.lastInferMs = inferMs;
          this.status.lastResult = res;
          return res;
        } catch (err) {
          this.status.error = err instanceof Error ? err.message : String(err);
          return this.status.lastResult;
        } finally {
          this.busy = false;
        }
      }
      return this.status.lastResult;
    }
  }

  // packages/runtime/src/vision.ts
  var DEFAULT_STK_CROPS = [
    { label: "MINIMAP", x: 0, y: 0.58, w: 0.28, h: 0.41 },
    { label: "TUTORIAL PROMPT", x: 0.12, y: 0.84, w: 0.76, h: 0.16 },
    { label: "LOOKAHEAD & ALERT", x: 0.22, y: 0.22, w: 0.56, h: 0.38 }
  ];
  function createInitialRoadModel() {
    return {
      r: 125,
      g: 118,
      b: 108,
      initialized: false,
      shoulderR: 0,
      shoulderG: 0,
      shoulderB: 0,
      shoulderInitialized: false
    };
  }
  function computeSandPenalty(r, g, b, roadLum) {
    if (roadLum >= 175)
      return 0;
    const lum = (r + g + b) / 3;
    const yellowExcess = (r + g) * 0.5 - b;
    const rg = r - g;
    if (lum > 145 && yellowExcess > 28 && rg < 35 && g > 135) {
      const lumFactor = Math.min(1, (lum - 145) / 25);
      const yellowFactor = Math.min(1, (yellowExcess - 28) / 22);
      return 0.95 * Math.max(0.55, lumFactor * yellowFactor);
    }
    return 0;
  }
  function isSaturatedBlueCurb(r, g, b) {
    return b > 150 && b - r > 42 && (b - g > 12 || g > 115);
  }
  function isSaturatedRedCurb(r, g, b) {
    return r > 175 && r - g > 60 && r - b > 45;
  }
  function computeCurbStripePenalty(r, g, b, neighborR, neighborG, neighborB, evalModel) {
    const roadBlueExcess = evalModel.b - evalModel.r;
    const roadRedExcess = evalModel.r - evalModel.g;
    const refLum = (evalModel.r + evalModel.g + evalModel.b) / 3;
    if (roadBlueExcess < 28 && isSaturatedBlueCurb(r, g, b)) {
      return 0.72;
    }
    if (roadRedExcess < 45 && isSaturatedRedCurb(r, g, b)) {
      return 0.72;
    }
    if (refLum < 185) {
      const lum = (r + g + b) / 3;
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const neighborLum = (neighborR + neighborG + neighborB) / 3;
      const neighborIsCurb = roadBlueExcess < 28 && isSaturatedBlueCurb(neighborR, neighborG, neighborB) || roadRedExcess < 45 && isSaturatedRedCurb(neighborR, neighborG, neighborB);
      if (lum > 208 && chroma < 28 && neighborIsCurb && Math.abs(lum - neighborLum) > 50) {
        return 0.55;
      }
    }
    return 0;
  }
  function rgbColorDistance(r1, g1, b1, r2, g2, b2) {
    const rg1 = r1 - g1;
    const gb1 = g1 - b1;
    const lum1 = (r1 + g1 + b1) / 3;
    const rg2 = r2 - g2;
    const gb2 = g2 - b2;
    const lum2 = (r2 + g2 + b2) / 3;
    const chromaDiff = (Math.abs(rg1 - rg2) + Math.abs(gb1 - gb2)) / 510;
    const lumDiff = Math.abs(lum1 - lum2) / 255;
    return chromaDiff * 0.58 + lumDiff * 0.48;
  }
  function computeCorridorCentroid(scores, navThreshold = 0.45) {
    const numCols = scores.length;
    let maxScore = 0;
    let totalActiveCols = 0;
    let totalExcessSum = 0;
    for (let c = 0;c < numCols; c++) {
      if (scores[c] > maxScore)
        maxScore = scores[c];
      const ex = Math.max(0, scores[c] - navThreshold);
      if (ex > 0) {
        totalActiveCols++;
        totalExcessSum += ex / (1 - navThreshold);
      }
    }
    let bestRunScore = -1;
    let bestOffsetX = 0;
    let c = 0;
    while (c < numCols) {
      if (scores[c] <= navThreshold) {
        c++;
        continue;
      }
      let end = c;
      let wSum = 0;
      let wxSum = 0;
      let runScore = 0;
      while (end < numCols && scores[end] > navThreshold) {
        const ex = scores[end] - navThreshold;
        const normX = (end + 0.5) / numCols * 2 - 1;
        const w = ex * ex;
        wSum += w;
        wxSum += w * normX;
        runScore += scores[end] * scores[end] * (1 - 0.08 * Math.abs(normX));
        end++;
      }
      if (runScore > bestRunScore && wSum > 0.000001) {
        bestRunScore = runScore;
        bestOffsetX = wxSum / wSum;
      }
      c = end;
    }
    return {
      offsetX: bestOffsetX,
      activeCols: totalActiveCols,
      meanStrength: totalActiveCols > 0 ? totalExcessSum / totalActiveCols : 0,
      maxScore
    };
  }
  function analyzeRgbaFrame(rgba, prevRgba, width, height, roadModel = createInitialRoadModel()) {
    let motionSum = 0;
    let motionCount = 0;
    if (prevRgba && prevRgba.length === rgba.length) {
      const xStart = Math.floor(width * 0.12);
      const xEnd = Math.floor(width * 0.88);
      const yStart = Math.floor(height * 0.35);
      const yEnd = Math.floor(height * 0.8);
      for (let y = yStart;y < yEnd; y += 2) {
        for (let x = xStart;x < xEnd; x += 2) {
          const idx = (y * width + x) * 4;
          const dr = Math.abs(rgba[idx] - prevRgba[idx]);
          const dg = Math.abs(rgba[idx + 1] - prevRgba[idx + 1]);
          const db = Math.abs(rgba[idx + 2] - prevRgba[idx + 2]);
          motionSum += (dr + dg + db) / (3 * 255);
          motionCount++;
        }
      }
    }
    const motionScore = motionCount > 0 ? motionSum / motionCount : 0;
    let bannerChanged = 0;
    let bannerPixels = 0;
    let alertScore = 0;
    let skySampleR = 0;
    let skySampleG = 0;
    let skySampleB = 0;
    let skySampleCnt = 0;
    {
      const xStart = Math.floor(width * 0.15);
      const xEnd = Math.floor(width * 0.85);
      const yStart = Math.floor(height * 0.05);
      const yEnd = Math.floor(height * 0.35);
      const skyYEnd = Math.floor(height * 0.16);
      const wwX0 = Math.floor(width * 0.28);
      const wwX1 = Math.floor(width * 0.72);
      const wwY0 = Math.floor(height * 0.22);
      const hasDarkOutlineNeighbor = (cx, cy) => {
        const offsets = [
          [-2, 0],
          [2, 0],
          [0, -2],
          [0, 2],
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1]
        ];
        for (const [dx, dy] of offsets) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height)
            continue;
          const nIdx = (ny * width + nx) * 4;
          const nLum = (rgba[nIdx] + rgba[nIdx + 1] + rgba[nIdx + 2]) / 3;
          if (nLum < 55)
            return true;
        }
        return false;
      };
      for (let y = yStart;y < yEnd; y += 2) {
        for (let x = xStart;x < xEnd; x += 2) {
          const idx = (y * width + x) * 4;
          const r = rgba[idx];
          const g = rgba[idx + 1];
          const b = rgba[idx + 2];
          if (y <= skyYEnd) {
            skySampleR += r;
            skySampleG += g;
            skySampleB += b;
            skySampleCnt++;
          }
          if (r > 175 && r - g > 65 && r - b > 65) {
            alertScore += 1;
          } else if (y >= wwY0 && x >= wwX0 && x <= wwX1 && r >= 210 && g >= 95 && g <= 185 && b <= 55 && r - g >= 30 && r - b >= 155 && hasDarkOutlineNeighbor(x, y)) {
            alertScore += 2.5;
          }
          if (prevRgba && prevRgba.length === rgba.length) {
            const lum = 0.299 * r + 0.587 * g + 0.114 * b;
            const prevLum = 0.299 * prevRgba[idx] + 0.587 * prevRgba[idx + 1] + 0.114 * prevRgba[idx + 2];
            if (Math.abs(lum - prevLum) > 36) {
              bannerChanged++;
            }
          }
          bannerPixels++;
        }
      }
    }
    const bannerDelta = bannerPixels > 0 ? bannerChanged / bannerPixels : 0;
    const redAlertRatio = bannerPixels > 0 ? Math.min(1, alertScore / bannerPixels) : 0;
    const meanSkyR = skySampleCnt > 0 ? skySampleR / skySampleCnt : 115;
    const meanSkyG = skySampleCnt > 0 ? skySampleG / skySampleCnt : 175;
    const meanSkyB = skySampleCnt > 0 ? skySampleB / skySampleCnt : 240;
    const wheelPixels = [];
    let seedTotal = 0;
    const isPixelCurbPaint = (px, py) => {
      const cx = Math.max(0, Math.min(width - 1, px));
      const cy = Math.max(0, Math.min(height - 1, py));
      const i = (cy * width + cx) * 4;
      return isSaturatedBlueCurb(rgba[i], rgba[i + 1], rgba[i + 2]) || isSaturatedRedCurb(rgba[i], rgba[i + 1], rgba[i + 2]);
    };
    const collectPatch = (x0Frac, x1Frac, y0Frac, y1Frac, weight = 1) => {
      const xs = Math.floor(width * x0Frac);
      const xe = Math.floor(width * x1Frac);
      const ys = Math.floor(height * y0Frac);
      const ye = Math.floor(height * y1Frac);
      for (let y = ys;y < ye; y += 2) {
        for (let x = xs;x < xe; x += 2) {
          seedTotal += weight;
          const idx = (y * width + x) * 4;
          const r = rgba[idx];
          const g = rgba[idx + 1];
          const b = rgba[idx + 2];
          const rx = (y * width + Math.min(width - 1, x + 2)) * 4;
          const dy = (Math.min(height - 1, y + 2) * width + x) * 4;
          const edgeX = (Math.abs(r - rgba[rx]) + Math.abs(g - rgba[rx + 1]) + Math.abs(b - rgba[rx + 2])) / (3 * 255);
          const edgeY = (Math.abs(r - rgba[dy]) + Math.abs(g - rgba[dy + 1]) + Math.abs(b - rgba[dy + 2])) / (3 * 255);
          const nearCurb = isPixelCurbPaint(x - 3, y) || isPixelCurbPaint(x + 3, y) || isPixelCurbPaint(x, y - 3) || isPixelCurbPaint(x, y + 3);
          wheelPixels.push([r, g, b, weight, Math.max(edgeX, edgeY), nearCurb]);
        }
      }
    };
    collectPatch(0.28, 0.39, 0.64, 0.75, 1);
    collectPatch(0.61, 0.72, 0.64, 0.75, 1);
    collectPatch(0.38, 0.62, 0.44, 0.51, 2);
    let seedR = 0;
    let seedG = 0;
    let seedB = 0;
    let seedValid = 0;
    for (const [r, g, b, weight, localEdge, nearCurb] of wheelPixels) {
      const lum = (r + g + b) / 3;
      if (lum < 22 || lum > 242)
        continue;
      if (b - r > 22 && lum > 110 && rgbColorDistance(r, g, b, meanSkyR, meanSkyG, meanSkyB) < 0.08) {
        continue;
      }
      if (r - g > 72 && r > 180)
        continue;
      if (roadModel.initialized) {
        const modelLum = (roadModel.r + roadModel.g + roadModel.b) / 3;
        const modelGreen = roadModel.g - Math.max(roadModel.r, roadModel.b);
        if (modelGreen < 8 && g - Math.max(r, b) > 16)
          continue;
        if (computeSandPenalty(r, g, b, modelLum) > 0.15)
          continue;
        if (roadModel.b - roadModel.r < 28 && isSaturatedBlueCurb(r, g, b) || roadModel.r - roadModel.g < 45 && isSaturatedRedCurb(r, g, b) || modelLum < 185 && nearCurb && lum > 205 && Math.max(r, g, b) - Math.min(r, g, b) < 28) {
          continue;
        }
        if (roadModel.shoulderInitialized && rgbColorDistance(r, g, b, roadModel.shoulderR ?? 0, roadModel.shoulderG ?? 0, roadModel.shoulderB ?? 0) < 0.1) {
          continue;
        }
      } else {
        const greenExcess = g - Math.max(r, b);
        if (greenExcess > 26)
          continue;
        if (computeSandPenalty(r, g, b, 120) > 0.15)
          continue;
        if (isSaturatedBlueCurb(r, g, b) || isSaturatedRedCurb(r, g, b))
          continue;
        if (lum > 198 && (localEdge > 0.22 || nearCurb))
          continue;
      }
      seedR += r * weight;
      seedG += g * weight;
      seedB += b * weight;
      seedValid += weight;
    }
    let evalModel = { ...roadModel };
    if (!evalModel.initialized && seedValid >= 8) {
      evalModel = {
        ...evalModel,
        r: seedR / seedValid,
        g: seedG / seedValid,
        b: seedB / seedValid,
        initialized: true
      };
    }
    const numCols = 24;
    const rawFarScores = new Float64Array(numCols);
    const rawNearScores = new Float64Array(numCols);
    const rawCombinedScores = new Float64Array(numCols);
    const farRows = [Math.floor(height * 0.43), Math.floor(height * 0.48)];
    const nearRows = [Math.floor(height * 0.53), Math.floor(height * 0.59)];
    const allLookRows = [...farRows, ...nearRows];
    const upperWallRows = [Math.floor(height * 0.2), Math.floor(height * 0.28)];
    const midHorizonRow = Math.floor(height * 0.35);
    const refLum = (evalModel.r + evalModel.g + evalModel.b) / 3;
    const refGreen = evalModel.g - Math.max(evalModel.r, evalModel.b);
    const xMargin = Math.floor(width * 0.08);
    const spanW = width - 2 * xMargin;
    let outerEdgeR = 0;
    let outerEdgeG = 0;
    let outerEdgeB = 0;
    let outerEdgeCnt = 0;
    for (let c = 0;c < numCols; c++) {
      const x0 = xMargin + Math.floor(c / numCols * spanW);
      const x1 = Math.max(x0 + 1, xMargin + Math.floor((c + 1) / numCols * spanW));
      let farSum = 0;
      let farCnt = 0;
      let nearSum = 0;
      let nearCnt = 0;
      let curbHitCnt = 0;
      let colSampleCnt = 0;
      let midR = 0;
      let midG = 0;
      let midB = 0;
      let midCount = 0;
      for (let rIdx = 0;rIdx < allLookRows.length; rIdx++) {
        const y = allLookRows[rIdx];
        const isFar = rIdx < farRows.length;
        for (let x = x0;x < x1; x++) {
          const idx = (y * width + x) * 4;
          const r = rgba[idx];
          const g = rgba[idx + 1];
          const b = rgba[idx + 2];
          if (rIdx <= 2) {
            midR += r;
            midG += g;
            midB += b;
            midCount++;
          }
          if (c <= 1 || c >= numCols - 2) {
            outerEdgeR += r;
            outerEdgeG += g;
            outerEdgeB += b;
            outerEdgeCnt++;
          }
          const lum = (r + g + b) / 3;
          const colorDist = rgbColorDistance(r, g, b, evalModel.r, evalModel.g, evalModel.b);
          const rightIdx = (y * width + Math.min(width - 1, x + 1)) * 4;
          const edge = (Math.abs(r - rgba[rightIdx]) + Math.abs(g - rgba[rightIdx + 1]) + Math.abs(b - rgba[rightIdx + 2])) / (3 * 255);
          let nR = rgba[rightIdx];
          let nG = rgba[rightIdx + 1];
          let nB = rgba[rightIdx + 2];
          const probeOffsets = [
            [-3, 0],
            [3, 0],
            [0, -2],
            [0, 2]
          ];
          for (const [dx, dy] of probeOffsets) {
            const px = Math.max(0, Math.min(width - 1, x + dx));
            const py = Math.max(0, Math.min(height - 1, y + dy));
            const pIdx = (py * width + px) * 4;
            const pr = rgba[pIdx];
            const pg = rgba[pIdx + 1];
            const pb = rgba[pIdx + 2];
            if (isSaturatedBlueCurb(pr, pg, pb) || isSaturatedRedCurb(pr, pg, pb)) {
              nR = pr;
              nG = pg;
              nB = pb;
              break;
            }
          }
          const curbPenalty = computeCurbStripePenalty(r, g, b, nR, nG, nB, evalModel);
          if (curbPenalty > 0)
            curbHitCnt++;
          colSampleCnt++;
          const greenPenalty = refGreen >= 8 ? 0 : Math.max(0, (g - Math.max(r, b) - 12) / 55);
          const skyPenalty = b - r > 22 && lum > 125 && refLum < 185 ? 0.85 : 0;
          const redWallPenalty = r - g > 68 && evalModel.r - evalModel.g < 45 ? 0.55 : 0;
          const sandPenalty = computeSandPenalty(r, g, b, refLum);
          const glareWallPenalty = refLum < 175 && lum > 194 ? Math.min(0.75, (lum - 194) / 35) : 0;
          let shoulderPenalty = 0;
          if (evalModel.shoulderInitialized) {
            const distToShoulder = rgbColorDistance(r, g, b, evalModel.shoulderR ?? 0, evalModel.shoulderG ?? 0, evalModel.shoulderB ?? 0);
            if (distToShoulder < colorDist && distToShoulder < 0.14) {
              shoulderPenalty = 0.65 * (1 - distToShoulder / 0.14);
            }
          }
          const pixelScore = Math.max(0, 1 - (colorDist * 2.15 + edge * 0.85 + curbPenalty + greenPenalty + skyPenalty + redWallPenalty + sandPenalty + glareWallPenalty + shoulderPenalty));
          if (isFar) {
            farSum += pixelScore;
            farCnt++;
          } else {
            nearSum += pixelScore;
            nearCnt++;
          }
        }
      }
      let wallPenalty = 0;
      if (midCount > 0) {
        let upR = 0;
        let upG = 0;
        let upB = 0;
        let upCount = 0;
        for (const uy of upperWallRows) {
          for (let x = x0;x < x1; x++) {
            const idx = (uy * width + x) * 4;
            upR += rgba[idx];
            upG += rgba[idx + 1];
            upB += rgba[idx + 2];
            upCount++;
          }
        }
        let mhR = 0;
        let mhG = 0;
        let mhB = 0;
        let mhCount = 0;
        for (let x = x0;x < x1; x++) {
          const idx = (midHorizonRow * width + x) * 4;
          mhR += rgba[idx];
          mhG += rgba[idx + 1];
          mhB += rgba[idx + 2];
          mhCount++;
        }
        if (upCount > 0 && mhCount > 0) {
          upR /= upCount;
          upG /= upCount;
          upB /= upCount;
          mhR /= mhCount;
          mhG /= mhCount;
          mhB /= mhCount;
          const mR = midR / midCount;
          const mG = midG / midCount;
          const mB = midB / midCount;
          const upLum = (upR + upG + upB) / 3;
          const verticalRgbDiff = (Math.abs(upR - mR) + Math.abs(upG - mG) + Math.abs(upB - mB)) / 3;
          const midHorizonDiff = (Math.abs(mhR - mR) + Math.abs(mhG - mG) + Math.abs(mhB - mB)) / 3;
          const chromaShift = Math.abs(upB - upR - (mB - mR));
          const upIsOpenSky = upB - upR > 18 && upLum > 105 && (verticalRgbDiff > 28 || chromaShift > 18);
          const upIsFoliage = upG - Math.max(upR, upB) > 12;
          const upIsPitchDark = upLum < 48;
          if (!upIsOpenSky && !upIsFoliage && !upIsPitchDark) {
            if (verticalRgbDiff < 26 && midHorizonDiff < 24) {
              wallPenalty = 0.85 * Math.min(1, (26 - verticalRgbDiff) / 14);
            }
          }
        }
      }
      const curbMarginPenalty = colSampleCnt > 0 ? 0.32 * Math.min(1, curbHitCnt / colSampleCnt * 2) : 0;
      const totalColPenalty = wallPenalty + curbMarginPenalty;
      const fScore = farCnt > 0 ? Math.max(0, farSum / farCnt - totalColPenalty) : 0;
      const nScore = nearCnt > 0 ? Math.max(0, nearSum / nearCnt - totalColPenalty) : 0;
      rawFarScores[c] = fScore;
      rawNearScores[c] = nScore;
      rawCombinedScores[c] = 0.46 * fScore + 0.54 * nScore;
    }
    const smoothCols = (arr) => {
      const out = new Float64Array(numCols);
      for (let c = 0;c < numCols; c++) {
        const left = c > 0 ? arr[c - 1] : arr[c];
        const right = c < numCols - 1 ? arr[c + 1] : arr[c];
        out[c] = 0.25 * left + 0.5 * arr[c] + 0.25 * right;
      }
      return out;
    };
    const farSmooth = smoothCols(rawFarScores);
    const nearSmooth = smoothCols(rawNearScores);
    const combinedSmooth = smoothCols(rawCombinedScores);
    const farStats = computeCorridorCentroid(farSmooth, 0.45);
    const nearStats = computeCorridorCentroid(nearSmooth, 0.45);
    const combStats = computeCorridorCentroid(combinedSmooth, 0.45);
    let roadOffsetX = combStats.offsetX;
    let roadCurvature = 0;
    if (farStats.activeCols >= 2 && nearStats.activeCols >= 2) {
      roadOffsetX = 0.52 * nearStats.offsetX + 0.48 * farStats.offsetX;
      roadCurvature = farStats.offsetX - nearStats.offsetX;
    } else if (farStats.activeCols >= 2 && nearStats.activeCols === 0) {
      roadOffsetX = farStats.offsetX;
    }
    const widthSupport = Math.min(1, combStats.activeCols / 6);
    const roadConfidence = combStats.activeCols === 0 ? combStats.maxScore * 0.25 : Math.min(1, widthSupport * (0.35 + 0.65 * combStats.meanStrength));
    let nextModel = { ...evalModel };
    const seedValidRatio = seedTotal > 0 ? seedValid / seedTotal : 0;
    if (seedValid >= 10 && seedValidRatio >= 0.4 && roadConfidence >= 0.52 && Math.abs(roadOffsetX) <= 0.36) {
      const avgR = seedR / seedValid;
      const avgG = seedG / seedValid;
      const avgB = seedB / seedValid;
      if (!roadModel.initialized) {
        nextModel = { ...nextModel, r: avgR, g: avgG, b: avgB, initialized: true };
      } else {
        const alpha = 0.08;
        nextModel = {
          ...nextModel,
          r: roadModel.r * (1 - alpha) + avgR * alpha,
          g: roadModel.g * (1 - alpha) + avgG * alpha,
          b: roadModel.b * (1 - alpha) + avgB * alpha,
          initialized: true
        };
      }
      if (outerEdgeCnt >= 8 && roadConfidence >= 0.58 && Math.abs(roadOffsetX) <= 0.25 && combStats.activeCols <= 21) {
        const oR = outerEdgeR / outerEdgeCnt;
        const oG = outerEdgeG / outerEdgeCnt;
        const oB = outerEdgeB / outerEdgeCnt;
        if (rgbColorDistance(oR, oG, oB, nextModel.r, nextModel.g, nextModel.b) >= 0.18) {
          if (!nextModel.shoulderInitialized) {
            nextModel.shoulderR = oR;
            nextModel.shoulderG = oG;
            nextModel.shoulderB = oB;
            nextModel.shoulderInitialized = true;
          } else {
            const sAlpha = 0.12;
            nextModel.shoulderR = (nextModel.shoulderR ?? oR) * (1 - sAlpha) + oR * sAlpha;
            nextModel.shoulderG = (nextModel.shoulderG ?? oG) * (1 - sAlpha) + oG * sAlpha;
            nextModel.shoulderB = (nextModel.shoulderB ?? oB) * (1 - sAlpha) + oB * sAlpha;
          }
        }
      }
    } else if (!roadModel.initialized && roadConfidence < 0.52) {
      nextModel = { ...roadModel };
    }
    return {
      motionScore,
      bannerDelta,
      redAlertRatio,
      roadOffsetX,
      roadCurvature,
      roadConfidence,
      updatedRoadModel: nextModel
    };
  }

  class MinimapTracker {
    prevCandidates = [];
    prevPos = null;
    history = [];
    hx = 0;
    hy = -1;
    headingValid = false;
    speed = 0;
    distance = 0;
    lastTurnAhead = 0;
    reset() {
      this.prevCandidates = [];
      this.prevPos = null;
      this.history = [];
      this.hx = 0;
      this.hy = -1;
      this.headingValid = false;
      this.speed = 0;
      this.distance = 0;
      this.lastTurnAhead = 0;
    }
    getSummary() {
      return {
        visible: this.prevPos !== null,
        onRibbon: this.prevPos !== null,
        ribbonPixels: 0,
        playerPos: this.prevPos ? [...this.prevPos] : null,
        headingDeg: this.headingValid ? Number((Math.atan2(this.hy, this.hx) * 180 / Math.PI).toFixed(1)) : null,
        headingValid: this.headingValid,
        turnAhead: this.lastTurnAhead,
        speed: this.speed,
        distance: this.distance
      };
    }
    step(rgba, mmW, mmH) {
      const scale = mmW / 64;
      const total = mmW * mmH;
      const ribbonMask = new Uint8Array(total);
      let ribbonPixels = 0;
      const lumArr = new Float32Array(total);
      const brightCandidate = new Uint8Array(total);
      for (let y = 0;y < mmH; y++) {
        for (let x = 0;x < mmW; x++) {
          const p = y * mmW + x;
          const idx = p * 4;
          const r = rgba[idx];
          const g = rgba[idx + 1];
          const b = rgba[idx + 2];
          const lum = (r + g + b) / 3;
          lumArr[p] = lum;
          if (x >= 2 && x < mmW - 2 && y >= 2 && y < mmH - 2) {
            const chr = Math.max(r, g, b) - Math.min(r, g, b);
            if (lum > 168 && chr < 38) {
              brightCandidate[p] = 1;
            }
          }
        }
      }
      const maxSearch = Math.max(4, Math.round(5 * scale));
      const maxSpan = Math.max(6, Math.round(6 * scale));
      const checkAxis = (x, y, centerLum, dx, dy) => {
        let dNeg = 0;
        for (let s = 1;s <= maxSearch; s++) {
          const nx = x - dx * s;
          const ny = y - dy * s;
          if (nx < 0 || nx >= mmW || ny < 0 || ny >= mmH)
            break;
          if (centerLum - lumArr[ny * mmW + nx] >= 26) {
            dNeg = s;
            break;
          }
        }
        if (dNeg === 0)
          return false;
        let dPos = 0;
        for (let s = 1;s <= maxSearch; s++) {
          const px = x + dx * s;
          const py = y + dy * s;
          if (px < 0 || px >= mmW || py < 0 || py >= mmH)
            break;
          if (centerLum - lumArr[py * mmW + px] >= 26) {
            dPos = s;
            break;
          }
        }
        if (dPos === 0)
          return false;
        const stepScale = dx !== 0 && dy !== 0 ? 1.414 : 1;
        return (dNeg + dPos) * stepScale <= maxSpan;
      };
      for (let y = 2;y < mmH - 2; y++) {
        for (let x = 2;x < mmW - 2; x++) {
          const p = y * mmW + x;
          if (!brightCandidate[p])
            continue;
          const centerLum = lumArr[p];
          const isStroke = checkAxis(x, y, centerLum, 1, 0) || checkAxis(x, y, centerLum, 0, 1) || checkAxis(x, y, centerLum, 1, 1) && checkAxis(x, y, centerLum, 1, -1);
          if (isStroke) {
            ribbonMask[p] = 1;
            ribbonPixels++;
          }
        }
      }
      const visible = ribbonPixels >= Math.max(10, Math.round(16 * scale * scale));
      if (!visible) {
        return {
          visible: false,
          onRibbon: false,
          ribbonPixels,
          playerPos: null,
          headingDeg: this.headingValid ? Number((Math.atan2(this.hy, this.hx) * 180 / Math.PI).toFixed(1)) : null,
          headingValid: this.headingValid,
          turnAhead: 0,
          speed: 0,
          distance: Number(this.distance.toFixed(2))
        };
      }
      const redMask = new Uint8Array(total);
      for (let y = 2;y < mmH - 2; y++) {
        for (let x = 2;x < mmW - 2; x++) {
          const idx = (y * mmW + x) * 4;
          const r = rgba[idx];
          const g = rgba[idx + 1];
          const b = rgba[idx + 2];
          if (r > 165 && r - g > 45 && r - b > 25) {
            redMask[y * mmW + x] = 1;
          }
        }
      }
      const visited = new Uint8Array(total);
      const maxArea = Math.max(80, Math.floor(total * 0.06));
      const candidates = [];
      const tinyCandidates = [];
      const queue = new Int32Array(total);
      for (let y = 2;y < mmH - 2; y++) {
        for (let x = 2;x < mmW - 2; x++) {
          const start = y * mmW + x;
          if (!redMask[start] || visited[start])
            continue;
          let head = 0;
          let tail = 0;
          queue[tail++] = start;
          visited[start] = 1;
          let sumX = 0;
          let sumY = 0;
          let area = 0;
          while (head < tail) {
            const cur = queue[head++];
            const cx = cur % mmW;
            const cy = Math.floor(cur / mmW);
            sumX += cx;
            sumY += cy;
            area++;
            const neighbors = [cur - 1, cur + 1, cur - mmW, cur + mmW];
            for (const nb of neighbors) {
              if (nb < 0 || nb >= total)
                continue;
              if (!redMask[nb] || visited[nb])
                continue;
              visited[nb] = 1;
              queue[tail++] = nb;
            }
          }
          if (area <= maxArea) {
            const cx = sumX / area;
            const cy = sumY / area;
            let rHits = 0;
            const rad = Math.max(3, Math.round(5 * scale));
            for (let ry = -rad;ry <= rad; ry++) {
              for (let rx = -rad;rx <= rad; rx++) {
                const px = Math.round(cx + rx);
                const py = Math.round(cy + ry);
                if (px >= 0 && px < mmW && py >= 0 && py < mmH) {
                  if (ribbonMask[py * mmW + px])
                    rHits++;
                }
              }
            }
            const cand = { x: cx, y: cy, area, ribbonScore: rHits };
            if (area >= 2)
              candidates.push(cand);
            else
              tinyCandidates.push(cand);
          }
        }
      }
      const pool = candidates.length > 0 ? candidates : tinyCandidates;
      pool.sort((a, b) => b.ribbonScore - a.ribbonScore || b.area - a.area);
      const topPool = pool.slice(0, 4);
      if (topPool.length === 0) {
        return {
          visible: true,
          onRibbon: false,
          ribbonPixels,
          playerPos: null,
          headingDeg: this.headingValid ? Number((Math.atan2(this.hy, this.hx) * 180 / Math.PI).toFixed(1)) : null,
          headingValid: this.headingValid,
          turnAhead: 0,
          speed: 0,
          distance: Number(this.distance.toFixed(2))
        };
      }
      const maxStep = mmW * 0.28;
      const minMoveThresh = 0.35 * scale;
      let chosen = topPool[0];
      let switchedFromStatic = false;
      let switchAnchor = null;
      if (this.prevCandidates.length > 0) {
        let bestScore = -Infinity;
        for (const c of topPool) {
          let minOldDist = Infinity;
          let closestOld = null;
          for (const old of this.prevCandidates) {
            const d = Math.hypot(c.x - old.x, c.y - old.y);
            if (d < minOldDist) {
              minOldDist = d;
              closestOld = old;
            }
          }
          const dPrev = this.prevPos ? Math.hypot(c.x - this.prevPos[0], c.y - this.prevPos[1]) : Infinity;
          const isMovingMatch = minOldDist >= minMoveThresh && minOldDist <= maxStep;
          const isStationary = minOldDist < 0.22 * scale;
          let score = Math.min(20, c.ribbonScore) * 0.25 + Math.min(12, c.area) * 0.15;
          if (isMovingMatch)
            score += 25;
          else if (isStationary)
            score -= 8;
          if (dPrev <= mmW * 0.22)
            score += 8 - dPrev * 0.2;
          if (score > bestScore) {
            bestScore = score;
            chosen = c;
            if (isMovingMatch && this.prevPos && dPrev > mmW * 0.22 && closestOld) {
              switchedFromStatic = true;
              switchAnchor = [closestOld.x, closestOld.y];
            }
          }
        }
      }
      this.prevCandidates = topPool;
      const chosenPos = [chosen.x, chosen.y];
      if (switchedFromStatic && switchAnchor) {
        this.history = [switchAnchor, chosenPos];
        this.headingValid = false;
        this.prevPos = switchAnchor;
      }
      if (this.prevPos) {
        const stepDist = Math.hypot(chosenPos[0] - this.prevPos[0], chosenPos[1] - this.prevPos[1]);
        if (stepDist > maxStep) {
          this.history = [chosenPos];
          this.headingValid = false;
          this.speed = 0;
        } else {
          this.distance += stepDist;
          this.speed = Number(stepDist.toFixed(3));
          this.history.push(chosenPos);
          if (this.history.length > 10)
            this.history.shift();
          const minAnchorDist = 1.4 * scale;
          let anchor = null;
          for (let i = 0;i < this.history.length - 1; i++) {
            const hPt = this.history[i];
            const d = Math.hypot(chosenPos[0] - hPt[0], chosenPos[1] - hPt[1]);
            if (d >= minAnchorDist) {
              anchor = hPt;
              break;
            }
          }
          if (anchor) {
            const dx = chosenPos[0] - anchor[0];
            const dy = chosenPos[1] - anchor[1];
            const len = Math.hypot(dx, dy);
            if (len > 0.0001) {
              const ux = dx / len;
              const uy = dy / len;
              if (!this.headingValid) {
                this.hx = ux;
                this.hy = uy;
                this.headingValid = true;
              } else {
                const alpha = 0.48;
                const bx = this.hx * (1 - alpha) + ux * alpha;
                const by = this.hy * (1 - alpha) + uy * alpha;
                const bLen = Math.hypot(bx, by);
                if (bLen > 0.0001) {
                  this.hx = bx / bLen;
                  this.hy = by / bLen;
                }
              }
            }
          }
        }
      } else {
        this.history = [chosenPos];
        this.speed = 0;
      }
      this.prevPos = chosenPos;
      let nearbyRibbon = 0;
      for (let dy = -2;dy <= 2; dy++) {
        for (let dx = -2;dx <= 2; dx++) {
          const px = Math.round(chosenPos[0] + dx);
          const py = Math.round(chosenPos[1] + dy);
          if (px >= 0 && px < mmW && py >= 0 && py < mmH) {
            if (ribbonMask[py * mmW + px])
              nearbyRibbon++;
          }
        }
      }
      const onRibbon = nearbyRibbon >= 2;
      let turnAhead = 0;
      if (this.headingValid) {
        const rx = -this.hy;
        const ry = this.hx;
        const anglesDeg = [];
        for (let a = -80;a <= 80; a += 10)
          anglesDeg.push(a);
        const rawRay = new Float64Array(anglesDeg.length);
        const radii = [4.5 * scale, 7.5 * scale, 10.5 * scale];
        for (let i = 0;i < anglesDeg.length; i++) {
          const rad = anglesDeg[i] * Math.PI / 180;
          const dirX = Math.cos(rad) * this.hx + Math.sin(rad) * rx;
          const dirY = Math.cos(rad) * this.hy + Math.sin(rad) * ry;
          let hitScore = 0;
          for (const r of radii) {
            const sx = chosenPos[0] + dirX * r;
            const sy = chosenPos[1] + dirY * r;
            let matched = false;
            for (let oy = -1;oy <= 1 && !matched; oy++) {
              for (let ox = -1;ox <= 1 && !matched; ox++) {
                const px = Math.round(sx + ox);
                const py = Math.round(sy + oy);
                if (px >= 0 && px < mmW && py >= 0 && py < mmH) {
                  if (ribbonMask[py * mmW + px])
                    matched = true;
                }
              }
            }
            if (matched)
              hitScore += 1 / radii.length;
          }
          rawRay[i] = hitScore;
        }
        const smoothRay = new Float64Array(anglesDeg.length);
        for (let i = 0;i < anglesDeg.length; i++) {
          const l = i > 0 ? rawRay[i - 1] : rawRay[i];
          const r = i < anglesDeg.length - 1 ? rawRay[i + 1] : rawRay[i];
          smoothRay[i] = 0.25 * l + 0.5 * rawRay[i] + 0.25 * r;
        }
        const thresh = 0.3;
        let bestScore = -1;
        let bestAngle = 0;
        let k = 0;
        while (k < anglesDeg.length) {
          if (smoothRay[k] <= thresh) {
            k++;
            continue;
          }
          let end = k;
          let wSum = 0;
          let waSum = 0;
          let runScore = 0;
          while (end < anglesDeg.length && smoothRay[end] > thresh) {
            const ex = smoothRay[end] - thresh + 0.05;
            const w = ex * ex;
            wSum += w;
            waSum += w * anglesDeg[end];
            runScore += smoothRay[end] * smoothRay[end] * (1 - 0.08 * (Math.abs(anglesDeg[end]) / 80));
            end++;
          }
          if (runScore > bestScore && wSum > 0.000001) {
            bestScore = runScore;
            bestAngle = waSum / wSum;
          }
          k = end;
        }
        if (bestScore > 0) {
          turnAhead = Number(Math.max(-1, Math.min(1, bestAngle / 65)).toFixed(3));
        }
      }
      this.lastTurnAhead = turnAhead;
      return {
        visible: true,
        onRibbon,
        ribbonPixels,
        playerPos: [Number(chosenPos[0].toFixed(2)), Number(chosenPos[1].toFixed(2))],
        headingDeg: this.headingValid ? Number((Math.atan2(this.hy, this.hx) * 180 / Math.PI).toFixed(1)) : null,
        headingValid: this.headingValid,
        turnAhead,
        speed: this.speed,
        distance: Number(this.distance.toFixed(2))
      };
    }
  }
  function analyzeMinimapRgba(rgba, mmW, mmH, tracker) {
    return tracker.step(rgba, mmW, mmH);
  }
  function detectRaceFinished(rgba, width, height, minimapVisible) {
    if (minimapVisible || width < 40 || height < 30)
      return false;
    let speedoBright = 0;
    let speedoTotal = 0;
    const spX0 = Math.floor(width * 0.82);
    const spX1 = Math.floor(width * 0.97);
    const spY0 = Math.floor(height * 0.74);
    const spY1 = Math.floor(height * 0.96);
    for (let y = spY0;y < spY1; y++) {
      for (let x = spX0;x < spX1; x++) {
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        const lum = (r + g + b) / 3;
        if (lum > 215 || b > 175 && g > 135 && b - r > 55) {
          speedoBright++;
        }
        speedoTotal++;
      }
    }
    if (speedoTotal > 0 && speedoBright / speedoTotal > 0.06) {
      return false;
    }
    const clkX0 = Math.floor(width * 0.78);
    const clkX1 = Math.floor(width * 0.99);
    const clkY0 = Math.floor(height * 0.01);
    const clkY1 = Math.floor(height * 0.12);
    let clockHits = 0;
    for (let y = clkY0;y < clkY1; y++) {
      for (let x = clkX0;x < clkX1; x++) {
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        const lum = (r + g + b) / 3;
        const chr = Math.max(r, g, b) - Math.min(r, g, b);
        if (lum > 220 && chr < 32) {
          let hasDarkBorder = false;
          for (let dy = -1;dy <= 1 && !hasDarkBorder; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= height)
              continue;
            for (let dx = -1;dx <= 1; dx++) {
              if (dx === 0 && dy === 0)
                continue;
              const nx = x + dx;
              if (nx < 0 || nx >= width)
                continue;
              const nIdx = (ny * width + nx) * 4;
              if ((rgba[nIdx] + rgba[nIdx + 1] + rgba[nIdx + 2]) / 3 < 55) {
                hasDarkBorder = true;
                break;
              }
            }
          }
          if (hasDarkBorder) {
            clockHits++;
            if (clockHits >= 3)
              return false;
          }
        }
      }
    }
    const inX0 = Math.floor(width * 0.22);
    const inX1 = Math.floor(width * 0.78);
    const inY0 = Math.floor(height * 0.2);
    const inY1 = Math.floor(height * 0.78);
    const midY = Math.floor(height * 0.48);
    const rs = [];
    const gs = [];
    const bs = [];
    let textEdges = 0;
    let upperUiTextEdges = 0;
    let lowerUiTextEdges = 0;
    let edgeSamples = 0;
    for (let y = inY0;y < inY1; y += 2) {
      for (let x = inX0;x < inX1; x += 2) {
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        rs.push(r);
        gs.push(g);
        bs.push(b);
        if (x + 1 < inX1 && y + 1 < inY1) {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const rIdx = (y * width + (x + 1)) * 4;
          const dIdx = ((y + 1) * width + x) * 4;
          const rLum = 0.299 * rgba[rIdx] + 0.587 * rgba[rIdx + 1] + 0.114 * rgba[rIdx + 2];
          const dLum = 0.299 * rgba[dIdx] + 0.587 * rgba[dIdx + 1] + 0.114 * rgba[dIdx + 2];
          const diffR = Math.abs(lum - rLum);
          const diffD = Math.abs(lum - dLum);
          if (diffR > 42 || diffD > 42) {
            textEdges++;
          }
          const cBright = (r + g + b) / 3 > 200 && Math.max(r, g, b) - Math.min(r, g, b) < 42;
          const rBright = (rgba[rIdx] + rgba[rIdx + 1] + rgba[rIdx + 2]) / 3 > 200 && Math.max(rgba[rIdx], rgba[rIdx + 1], rgba[rIdx + 2]) - Math.min(rgba[rIdx], rgba[rIdx + 1], rgba[rIdx + 2]) < 42;
          const dBright = (rgba[dIdx] + rgba[dIdx + 1] + rgba[dIdx + 2]) / 3 > 200 && Math.max(rgba[dIdx], rgba[dIdx + 1], rgba[dIdx + 2]) - Math.min(rgba[dIdx], rgba[dIdx + 1], rgba[dIdx + 2]) < 42;
          if ((cBright || rBright) && diffR > 45 || (cBright || dBright) && diffD > 45) {
            if (y < midY)
              upperUiTextEdges++;
            else
              lowerUiTextEdges++;
          }
          edgeSamples++;
        }
      }
    }
    if (rs.length < 20 || edgeSamples < 20)
      return false;
    const textEdgeRatio = textEdges / edgeSamples;
    if (textEdgeRatio < 0.035)
      return false;
    if (upperUiTextEdges < 4 || lowerUiTextEdges < 4)
      return false;
    const sortedR = [...rs].sort((a, b) => a - b);
    const sortedG = [...gs].sort((a, b) => a - b);
    const sortedB = [...bs].sort((a, b) => a - b);
    const mid = Math.floor(rs.length / 2);
    const medR = sortedR[mid];
    const medG = sortedG[mid];
    const medB = sortedB[mid];
    const medLum = (medR + medG + medB) / 3;
    if (medLum < 30 || medLum > 228)
      return false;
    if (medR - medB > 55)
      return false;
    let matchingModal = 0;
    for (let i = 0;i < rs.length; i++) {
      if (rgbColorDistance(rs[i], gs[i], bs[i], medR, medG, medB) < 0.14) {
        matchingModal++;
      }
    }
    const bgCohesion = matchingModal / rs.length;
    if (bgCohesion < 0.45)
      return false;
    let outR = 0;
    let outG = 0;
    let outB = 0;
    let outCnt = 0;
    const leftEnd = Math.floor(width * 0.11);
    const rightStart = Math.floor(width * 0.89);
    for (let y = inY0;y < inY1; y += 2) {
      for (let x = 2;x < leftEnd; x += 2) {
        const idx = (y * width + x) * 4;
        outR += rgba[idx];
        outG += rgba[idx + 1];
        outB += rgba[idx + 2];
        outCnt++;
      }
      for (let x = rightStart;x < width - 2; x += 2) {
        const idx = (y * width + x) * 4;
        outR += rgba[idx];
        outG += rgba[idx + 1];
        outB += rgba[idx + 2];
        outCnt++;
      }
    }
    if (outCnt === 0)
      return false;
    outR /= outCnt;
    outG /= outCnt;
    outB /= outCnt;
    const outerDiff = rgbColorDistance(outR, outG, outB, medR, medG, medB);
    return outerDiff >= 0.08;
  }
  function analyzeGtavRadarRgba(rgba, cw, ch) {
    if (cw < 16 || ch < 16 || rgba.length < cw * ch * 4) {
      return {
        radarVisible: false,
        healthPct: 0,
        lowHealth: false,
        enemyPixels: 0,
        enemiesAhead: 0,
        enemiesLeft: 0,
        enemiesRight: 0,
        enemiesBehind: 0,
        closestEnemyDist: null
      };
    }
    const rx0 = Math.floor(cw * 0.075);
    const rx1 = Math.min(cw, Math.ceil(cw * 0.78));
    const ry0 = Math.floor(ch * 0.1875);
    const ry1 = Math.min(ch, Math.ceil(ch * 0.842));
    const px = cw * 0.428;
    const py = ch * 0.65;
    let totalRadar = 0;
    let nonBlackRadar = 0;
    let redWash = 0;
    let enemyPixels = 0;
    let enemiesAhead = 0;
    let enemiesLeft = 0;
    let enemiesRight = 0;
    let enemiesBehind = 0;
    let minDist = Infinity;
    for (let y = ry0;y < ry1; y++) {
      for (let x = rx0;x < rx1; x++) {
        const idx = (y * cw + x) * 4;
        const r = rgba[idx] ?? 0;
        const g = rgba[idx + 1] ?? 0;
        const b = rgba[idx + 2] ?? 0;
        totalRadar++;
        if (r + g + b > 45)
          nonBlackRadar++;
        if (r > 135 && r > g + 35 && r > b + 35)
          redWash++;
        if (r > 165 && g < 85 && b < 85) {
          enemyPixels++;
          const dx = x - px;
          const dy = y - py;
          const dist = Math.hypot(dx, dy) / cw;
          if (dist < minDist)
            minDist = dist;
          if (dy <= 0 && Math.abs(dx) <= Math.abs(dy) * 1.15) {
            enemiesAhead++;
          } else if (dy > Math.abs(dx) * 1.15) {
            enemiesBehind++;
          } else if (dx < 0) {
            enemiesLeft++;
          } else {
            enemiesRight++;
          }
        }
      }
    }
    const hx0 = Math.floor(cw * 0.075);
    const hx1 = Math.min(cw, Math.ceil(cw * 0.42));
    const hy0 = Math.floor(ch * 0.86);
    const hy1 = Math.min(ch, Math.ceil(ch * 0.94));
    let barCols = 0;
    let greenCols = 0;
    let redBarCols = 0;
    for (let x = hx0;x < hx1; x++) {
      let hasGreen = false;
      let hasRed = false;
      for (let y = hy0;y < hy1; y++) {
        const idx = (y * cw + x) * 4;
        const r = rgba[idx] ?? 0;
        const g = rgba[idx + 1] ?? 0;
        const b = rgba[idx + 2] ?? 0;
        if (g > 105 && g > r + 18 && g > b + 15)
          hasGreen = true;
        if (r > 135 && r > g + 35 && r > b + 30)
          hasRed = true;
      }
      barCols++;
      if (hasGreen)
        greenCols++;
      if (hasRed)
        redBarCols++;
    }
    const radarVisible = totalRadar > 0 && nonBlackRadar / totalRadar > 0.2;
    const healthPct = barCols > 0 ? greenCols / barCols : 0;
    const redWashRatio = totalRadar > 0 ? redWash / totalRadar : 0;
    const lowHealth = radarVisible && (healthPct < 0.35 || barCols > 0 && redBarCols / barCols > 0.25 || redWashRatio > 0.25);
    return {
      radarVisible,
      healthPct,
      lowHealth,
      enemyPixels,
      enemiesAhead,
      enemiesLeft,
      enemiesRight,
      enemiesBehind,
      closestEnemyDist: Number.isFinite(minDist) ? minDist : null
    };
  }

  class VideoCaptureEngine {
    analysisCanvas;
    analysisCtx;
    minimapCanvas;
    minimapCtx;
    minimapTracker = new MinimapTracker;
    prevAnalysisRgba = null;
    roadModel = createInitialRoadModel();
    analysisW = 160;
    analysisH = 120;
    minimapW = 64;
    minimapH = 64;
    constructor() {
      this.analysisCanvas = document.createElement("canvas");
      this.analysisCanvas.width = this.analysisW;
      this.analysisCanvas.height = this.analysisH;
      const ctx = this.analysisCanvas.getContext("2d", { willReadFrequently: true });
      if (!ctx)
        throw new Error("Failed to initialize 2D analysis canvas context");
      this.analysisCtx = ctx;
      this.minimapCanvas = document.createElement("canvas");
      this.minimapCanvas.width = this.minimapW;
      this.minimapCanvas.height = this.minimapH;
      const mCtx = this.minimapCanvas.getContext("2d", { willReadFrequently: true });
      if (!mCtx)
        throw new Error("Failed to initialize 2D minimap canvas context");
      this.minimapCtx = mCtx;
    }
    resetTracking() {
      this.prevAnalysisRgba = null;
    }
    resetMinimap() {
      this.minimapTracker.reset();
    }
    resetRoadModel() {
      this.roadModel = createInitialRoadModel();
    }
    findVideoSurface() {
      let bestEl = null;
      let bestArea = 0;
      const canvases = Array.from(document.querySelectorAll("canvas"));
      for (const c of canvases) {
        if (c.dataset.gameplayOverlay === "true")
          continue;
        if (c.width < 200 || c.height < 150)
          continue;
        const area = c.width * c.height;
        if (area > bestArea) {
          bestArea = area;
          bestEl = c;
        }
      }
      const videos = Array.from(document.querySelectorAll("video"));
      for (const v of videos) {
        if (v.videoWidth < 200 || v.videoHeight < 150)
          continue;
        const area = v.videoWidth * v.videoHeight;
        if (area > bestArea) {
          bestArea = area;
          bestEl = v;
        }
      }
      return bestEl;
    }
    getSurfaceDimensions(el) {
      if (el instanceof HTMLVideoElement) {
        return { w: el.videoWidth, h: el.videoHeight };
      }
      return { w: el.width, h: el.height };
    }
    sampleAnalysis(surface, mutateModel = true) {
      this.analysisCtx.drawImage(surface, 0, 0, this.analysisW, this.analysisH);
      const img = this.analysisCtx.getImageData(0, 0, this.analysisW, this.analysisH);
      const rgba = new Uint8ClampedArray(img.data);
      const analysis = analyzeRgbaFrame(rgba, this.prevAnalysisRgba, this.analysisW, this.analysisH, this.roadModel);
      const dims = this.getSurfaceDimensions(surface);
      let minimap;
      if (dims.w > 0 && dims.h > 0) {
        const mx = 0;
        const my = Math.floor(dims.h * 0.58);
        const mw = Math.max(2, Math.floor(dims.w * 0.28));
        const mh = Math.max(2, Math.floor(dims.h * 0.41));
        this.minimapCtx.drawImage(surface, mx, my, mw, mh, 0, 0, this.minimapW, this.minimapH);
        const mmImg = this.minimapCtx.getImageData(0, 0, this.minimapW, this.minimapH);
        minimap = analyzeMinimapRgba(mmImg.data, this.minimapW, this.minimapH, this.minimapTracker);
      }
      const activeMinimapPresent = Boolean(minimap?.visible && minimap.onRibbon && minimap.ribbonPixels < this.minimapW * this.minimapH * 0.35);
      const raceFinishedCandidate = detectRaceFinished(rgba, this.analysisW, this.analysisH, activeMinimapPresent);
      if (mutateModel) {
        this.prevAnalysisRgba = rgba;
        this.roadModel = analysis.updatedRoadModel;
      }
      return {
        ...analysis,
        minimap,
        raceFinishedCandidate
      };
    }
    captureFullFrame(surface) {
      const { w, h } = this.getSurfaceDimensions(surface);
      if (w <= 0 || h <= 0)
        return null;
      const snap = document.createElement("canvas");
      snap.width = w;
      snap.height = h;
      const ctx = snap.getContext("2d");
      if (!ctx)
        return null;
      ctx.drawImage(surface, 0, 0, w, h);
      return snap;
    }
    readGtavRadar(surface) {
      const { w, h } = this.getSurfaceDimensions(surface);
      if (w <= 0 || h <= 0) {
        return analyzeGtavRadarRgba(new Uint8ClampedArray(0), 0, 0);
      }
      const cw = 128;
      const ch = 96;
      const sx = 0;
      const sy = Math.floor(h * 0.76);
      const sw = Math.max(16, Math.floor(w * 0.2));
      const sh = Math.max(16, h - sy);
      const canvas = document.createElement("canvas");
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx)
        return analyzeGtavRadarRgba(new Uint8ClampedArray(0), 0, 0);
      ctx.drawImage(surface, sx, sy, sw, sh, 0, 0, cw, ch);
      const img = ctx.getImageData(0, 0, cw, ch);
      return analyzeGtavRadarRgba(img.data, cw, ch);
    }
    captureTile(surface, tMs, axes, buttons, analysis, tileW = 320, tileH = 240, depth) {
      const tile = document.createElement("canvas");
      tile.width = tileW;
      tile.height = tileH;
      const ctx = tile.getContext("2d");
      if (!ctx)
        throw new Error("Failed to get 2D context for tile");
      ctx.drawImage(surface, 0, 0, tileW, tileH);
      return {
        tMs,
        width: tileW,
        height: tileH,
        canvas: tile,
        axes: [...axes],
        buttons: [...buttons],
        motionScore: analysis.motionScore,
        bannerDelta: analysis.bannerDelta,
        redAlertRatio: analysis.redAlertRatio,
        roadOffsetX: analysis.roadOffsetX,
        roadCurvature: analysis.roadCurvature,
        roadConfidence: analysis.roadConfidence,
        depthCorridorX: depth?.corridorOffsetX,
        depthClearance: depth?.centerClearance,
        minimapTurnAhead: analysis.minimap?.turnAhead,
        minimapHeadingDeg: analysis.minimap?.headingDeg
      };
    }
  }
  var BUTTON_TAGS = [
    [3, "GAS", "#22c55e"],
    [2, "BRK", "#ef4444"],
    [5, "DRIFT", "#f59e0b"],
    [4, "NITRO", "#38bdf8"],
    [1, "ITEM", "#a855f7"],
    [8, "RESCUE", "#ec4899"],
    [0, "A", "#94a3b8"],
    [9, "START", "#64748b"]
  ];
  function drawTileAnnotations(ctx, sample, x0, y0, w, h) {
    const motionPct = (sample.motionScore * 100).toFixed(1);
    const lowMotion = sample.tMs > 180 && sample.motionScore < 0.01;
    ctx.fillStyle = lowMotion ? "rgba(185, 28, 28, 0.85)" : "rgba(15, 23, 42, 0.78)";
    ctx.fillRect(x0 + 6, y0 + 6, 118, 22);
    ctx.font = "bold 12px ui-monospace, Menlo, monospace";
    ctx.fillStyle = "#f8fafc";
    ctx.fillText(`+${Math.round(sample.tMs)}ms  Δ${motionPct}%`, x0 + 12, y0 + 21);
    if (sample.roadConfidence > 0.15) {
      const px = x0 + (sample.roadOffsetX + 1) * 0.5 * w;
      const py = y0 + h * 0.52;
      ctx.strokeStyle = "#22d3ee";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px, py - 7);
      ctx.lineTo(px + 7, py);
      ctx.lineTo(px, py + 7);
      ctx.lineTo(px - 7, py);
      ctx.closePath();
      ctx.stroke();
    }
    if (typeof sample.depthCorridorX === "number") {
      const dx = x0 + (sample.depthCorridorX + 1) * 0.5 * w;
      const dy = y0 + h * 0.37;
      ctx.strokeStyle = "#4ade80";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(dx, dy, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    const stickCx = x0 + w - 28;
    const stickCy = y0 + h - 28;
    const r = 18;
    ctx.fillStyle = "rgba(15, 23, 42, 0.75)";
    ctx.beginPath();
    ctx.arc(stickCx, stickCy, r + 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#64748b";
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(stickCx, stickCy, r, 0, Math.PI * 2);
    ctx.stroke();
    const sx = sample.axes[0] ?? 0;
    const sy = sample.axes[1] ?? 0;
    ctx.strokeStyle = "#facc15";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(stickCx, stickCy);
    ctx.lineTo(stickCx + sx * r, stickCy + sy * r);
    ctx.stroke();
    ctx.fillStyle = "#facc15";
    ctx.beginPath();
    ctx.arc(stickCx + sx * r, stickCy + sy * r, 3.5, 0, Math.PI * 2);
    ctx.fill();
    let pillY = y0 + 6;
    for (const [idx, label, color] of BUTTON_TAGS) {
      if ((sample.buttons[idx] ?? 0) > 0.1) {
        ctx.fillStyle = color;
        ctx.fillRect(x0 + w - 58, pillY, 52, 17);
        ctx.fillStyle = "#0f172a";
        ctx.font = "bold 11px ui-monospace, Menlo, monospace";
        ctx.fillText(label, x0 + w - 53, pillY + 12);
        pillY += 19;
      }
    }
  }
  function buildContactSheetCanvas(samples, finalSurface, summary, crops = DEFAULT_STK_CROPS) {
    const maxTiles = 8;
    let chosen = [];
    if (samples.length <= maxTiles) {
      chosen = samples;
    } else {
      for (let i = 0;i < maxTiles; i++) {
        const idx = Math.round(i * (samples.length - 1) / (maxTiles - 1));
        chosen.push(samples[idx]);
      }
    }
    const cols = 4;
    const rows = Math.max(1, Math.ceil(chosen.length / cols));
    const tileW = chosen[0]?.width ?? 320;
    const tileH = chosen[0]?.height ?? 240;
    const gap = 6;
    const headerH = 38;
    const cropRowH = finalSurface && crops.length > 0 ? 186 : 0;
    const totalW = cols * tileW + (cols + 1) * gap;
    const totalH = headerH + rows * tileH + (rows + 1) * gap + cropRowH;
    const sheet = document.createElement("canvas");
    sheet.width = totalW;
    sheet.height = totalH;
    sheet.dataset.gameplayOverlay = "true";
    const ctx = sheet.getContext("2d");
    if (!ctx)
      throw new Error("Failed to get 2D context for contact sheet");
    ctx.fillStyle = "#0b1120";
    ctx.fillRect(0, 0, totalW, totalH);
    ctx.fillStyle = "#1e293b";
    ctx.fillRect(0, 0, totalW, headerH);
    ctx.fillStyle = "#f8fafc";
    ctx.font = "bold 15px ui-monospace, Menlo, monospace";
    const extras = [];
    if (summary.depthFramesUsed)
      extras.push(`d3=${summary.depthFramesUsed}`);
    if (summary.unwedgeCount)
      extras.push(`uw=${summary.unwedgeCount}`);
    if (typeof summary.minimapTurnAhead === "number" && Math.abs(summary.minimapTurnAhead) > 0.05) {
      extras.push(`mm=${summary.minimapTurnAhead >= 0 ? "+" : ""}${summary.minimapTurnAhead.toFixed(2)}`);
    }
    const extraStr = extras.length > 0 ? ` | ${extras.join(" ")}` : "";
    const headerText = `${summary.label} | stop=${summary.stopReason} | ${Math.round(summary.durationMs)}ms | avgΔ=${(summary.avgMotion * 100).toFixed(1)}% | roadConf=${(summary.avgRoadConfidence * 100).toFixed(0)}%${extraStr}`;
    ctx.fillText(headerText, 12, 24);
    for (let i = 0;i < chosen.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x0 = gap + col * (tileW + gap);
      const y0 = headerH + gap + row * (tileH + gap);
      ctx.drawImage(chosen[i].canvas, x0, y0, tileW, tileH);
      drawTileAnnotations(ctx, chosen[i], x0, y0, tileW, tileH);
    }
    if (finalSurface && cropRowH > 0) {
      const srcW = finalSurface instanceof HTMLVideoElement ? finalSurface.videoWidth : finalSurface.width;
      const srcH = finalSurface instanceof HTMLVideoElement ? finalSurface.videoHeight : finalSurface.height;
      const stripY = headerH + rows * (tileH + gap) + gap;
      const cropSlotW = Math.floor((totalW - (crops.length + 1) * gap) / crops.length);
      const cropH = cropRowH - 12;
      for (let i = 0;i < crops.length; i++) {
        const c = crops[i];
        const dx = gap + i * (cropSlotW + gap);
        const sx = Math.max(0, Math.floor(c.x * srcW));
        const sy = Math.max(0, Math.floor(c.y * srcH));
        const sw = Math.max(1, Math.min(srcW - sx, Math.floor(c.w * srcW)));
        const sh = Math.max(1, Math.min(srcH - sy, Math.floor(c.h * srcH)));
        ctx.fillStyle = "#111827";
        ctx.fillRect(dx, stripY, cropSlotW, cropH);
        const scale = Math.min(cropSlotW / sw, cropH / sh);
        const drawW = Math.floor(sw * scale);
        const drawH = Math.floor(sh * scale);
        const offsetX = dx + Math.floor((cropSlotW - drawW) / 2);
        const offsetY = stripY + Math.floor((cropH - drawH) / 2);
        ctx.drawImage(finalSurface, sx, sy, sw, sh, offsetX, offsetY, drawW, drawH);
        const pillLabel = `FINAL ${c.label}`;
        const pillW = Math.min(cropSlotW - 8, Math.ceil(16 + pillLabel.length * 7.6));
        ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
        ctx.fillRect(dx + 4, stripY + 4, pillW, 20);
        ctx.fillStyle = "#38bdf8";
        ctx.font = "bold 12px ui-monospace, Menlo, monospace";
        ctx.fillText(pillLabel, dx + 10, stripY + 18);
      }
    }
    return sheet;
  }
  var OVERLAY_ID = "__gameplay_sheet_overlay";
  function hideSheetOverlay() {
    if (typeof document === "undefined")
      return;
    const existing = document.getElementById(OVERLAY_ID);
    if (existing)
      existing.remove();
  }
  function showSheetOverlay(sheetCanvas) {
    if (typeof document === "undefined")
      return;
    hideSheetOverlay();
    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:#0b1120;display:flex;align-items:center;justify-content:center;padding:8px;pointer-events:none;";
    sheetCanvas.style.cssText = "max-width:100%;max-height:100%;object-fit:contain;border:1px solid #334155;";
    overlay.appendChild(sheetCanvas);
    document.body.appendChild(overlay);
  }

  // packages/runtime/src/controller.ts
  function computePidSteer(targetOffsetX, state, dtSec, kp = 0.95, kd = 0.22, maxSteer = 0.85, maxRatePerSec = 4.5) {
    const err = clamp(targetOffsetX, -1, 1);
    const safeDt = Math.max(0.005, dtSec);
    const deriv = (err - state.prevError) / safeDt;
    const raw = kp * err + kd * deriv;
    const desired = clamp(raw, -maxSteer, maxSteer);
    const maxStep = maxRatePerSec * safeDt;
    const delta = clamp(desired - state.prevSteer, -maxStep, maxStep);
    const steer = clamp(state.prevSteer + delta, -maxSteer, maxSteer);
    return {
      steer,
      nextState: { prevError: err, prevSteer: steer }
    };
  }
  function createGameplayOrchestrator(gamepad, captureEngine, depthEngine) {
    let engine = captureEngine ?? null;
    let depth = depthEngine ?? null;
    const recentHistory = [];
    const MAX_HISTORY_ENTRIES = 12;
    function recordHistory(entry) {
      recentHistory.push(entry);
      if (recentHistory.length > MAX_HISTORY_ENTRIES) {
        recentHistory.shift();
      }
    }
    function getRecentHistory() {
      return recentHistory.slice();
    }
    function getEngine() {
      if (!engine)
        engine = new VideoCaptureEngine;
      return engine;
    }
    function getDepthEngine() {
      if (!depth)
        depth = new BrowserDepthEngine;
      return depth;
    }
    async function initDepthEngine() {
      return await getDepthEngine().init();
    }
    function getDepthStatus() {
      return getDepthEngine().getStatus();
    }
    function resetRoadModel() {
      const eng = getEngine();
      if (typeof eng.resetRoadModel === "function") {
        eng.resetRoadModel();
      }
    }
    function summarizeSamples(samples, label, stopReason, durationMs, stuckDetected, ok, error, includeSheetDataUrl = false, surface = null, options = {}, extras = {}) {
      const count = samples.length;
      let sumMotion = 0;
      let minMotion = count > 1 ? Infinity : 0;
      let maxBannerDelta = 0;
      let maxRedAlertRatio = 0;
      let sumConf = 0;
      let sumSteer = 0;
      let sumCurvature = 0;
      for (let i = 0;i < count; i++) {
        const s = samples[i];
        if (i > 0) {
          sumMotion += s.motionScore;
          if (s.motionScore < minMotion)
            minMotion = s.motionScore;
          if (s.bannerDelta > maxBannerDelta)
            maxBannerDelta = s.bannerDelta;
        }
        if (s.redAlertRatio > maxRedAlertRatio)
          maxRedAlertRatio = s.redAlertRatio;
        sumConf += s.roadConfidence;
        sumSteer += s.axes[0] ?? 0;
        sumCurvature += s.roadCurvature ?? 0;
      }
      const avgMotion = count > 1 ? sumMotion / (count - 1) : 0;
      const avgRoadConfidence = count > 0 ? sumConf / count : 0;
      const meanSteerX = count > 0 ? sumSteer / count : 0;
      const meanCurvature = count > 0 ? sumCurvature / count : 0;
      let sheetDataUrl;
      if (count > 0 && (options.showSheetOverlay ?? true)) {
        const sheet = buildContactSheetCanvas(samples, surface, {
          label,
          stopReason,
          durationMs,
          avgMotion,
          avgRoadConfidence,
          depthFramesUsed: extras.depthFramesUsed,
          unwedgeCount: extras.unwedgeCount,
          minimapTurnAhead: extras.minimapTurnAhead
        }, options.crops ?? DEFAULT_STK_CROPS);
        showSheetOverlay(sheet);
        if (includeSheetDataUrl) {
          sheetDataUrl = sheet.toDataURL("image/jpeg", 0.82);
        }
      }
      recordHistory({
        timestamp: Date.now(),
        label,
        stopReason,
        durationMs,
        avgMotion,
        stuckDetected,
        ok
      });
      return {
        ok,
        error,
        label,
        stopReason,
        durationMs,
        framesCaptured: count,
        avgMotion,
        minMotion: Number.isFinite(minMotion) ? minMotion : 0,
        maxBannerDelta,
        maxRedAlertRatio,
        avgRoadConfidence,
        meanSteerX,
        meanCurvature,
        stuckDetected,
        unwedgeCount: extras.unwedgeCount,
        raceFinished: extras.raceFinished,
        depthFramesUsed: extras.depthFramesUsed,
        minimapHeadingDeg: extras.minimapHeadingDeg,
        minimapTurnAhead: extras.minimapTurnAhead,
        minimapDistance: extras.minimapDistance,
        finalState: gamepad.getState(),
        sheetDataUrl
      };
    }
    async function runChunk(actions, options = {}) {
      const {
        unpause = true,
        unpauseButton = BTN.A,
        pause = true,
        pauseButton = BTN.START,
        unpauseSettleMs = 220,
        pauseSettleMs = 150,
        sampleIntervalMs = 140,
        holdGasButton = null,
        resetOnEnd = true,
        stopOnStuck = true,
        stuckThreshold = 0.008,
        stuckDurationMs = 600,
        label = "chunk"
      } = options;
      hideSheetOverlay();
      const eng = getEngine();
      eng.resetTracking();
      if (!unpause && typeof eng.resetRoadModel === "function") {
        eng.resetRoadModel();
      }
      const surface = eng.findVideoSurface();
      const samples = [];
      let aborted = false;
      let stopReason = "completed";
      let stuckDetected = false;
      let lowMotionMs = 0;
      let lastSampleAt = 0;
      const startedAt = performance.now();
      function captureNow() {
        if (!surface)
          return;
        const now = performance.now();
        const dt = lastSampleAt > 0 ? now - lastSampleAt : 0;
        lastSampleAt = now;
        const analysis = eng.sampleAnalysis(surface);
        const state = gamepad.getState();
        const elapsed = now - startedAt;
        samples.push(eng.captureTile(surface, elapsed, state.axes, state.buttons, analysis));
        if (stopOnStuck && samples.length >= 3 && elapsed > 350) {
          if (analysis.motionScore < stuckThreshold) {
            lowMotionMs += dt;
            if (lowMotionMs >= stuckDurationMs) {
              stuckDetected = true;
              aborted = true;
              stopReason = "stuck";
            }
          } else {
            lowMotionMs = 0;
          }
        }
      }
      let timerId;
      let errMsg;
      let ok = true;
      let prePauseSurface = null;
      try {
        if (unpause) {
          await gamepad.tapButton(unpauseButton, 90, unpauseSettleMs);
        }
        if (holdGasButton !== null) {
          gamepad.setButton(holdGasButton, 1);
        }
        captureNow();
        timerId = window.setInterval(captureNow, sampleIntervalMs);
        await actions({
          api: gamepad,
          shouldAbort: () => aborted,
          captureNow
        });
        captureNow();
      } catch (err) {
        ok = false;
        stopReason = "error";
        errMsg = err instanceof Error ? err.message : String(err);
      } finally {
        if (timerId !== undefined)
          window.clearInterval(timerId);
        if (surface && typeof eng.captureFullFrame === "function") {
          try {
            prePauseSurface = eng.captureFullFrame(surface);
          } catch {}
        }
        if (resetOnEnd) {
          gamepad.resetAll();
        }
        if (pause) {
          try {
            await gamepad.tapButton(pauseButton, 90, pauseSettleMs);
          } catch {}
          if (resetOnEnd) {
            gamepad.resetAll();
          }
        }
      }
      const durationMs = performance.now() - startedAt;
      return summarizeSamples(samples, label, stopReason, durationMs, stuckDetected, ok, errMsg, false, prePauseSurface ?? surface, options);
    }
    async function driveServo(options = {}) {
      const {
        maxDurationMs = 7000,
        tickMs = 33,
        kp = 1.25,
        kd = 0.25,
        maxSteer = 0.95,
        gasButton = BTN.Y,
        throttleModulation = true,
        autoCornerBrake = true,
        steerBias = 0,
        depthSteerHint,
        depthHintWeight = 0.3,
        stopOnBannerChange = false,
        bannerDeltaThreshold = 0.28,
        stopOnLowConfidence = true,
        minConfidence = 0.25,
        lowConfidenceMs = 280,
        stopOnRedAlert = true,
        redAlertThreshold = 0.035,
        autoUnwedge = true,
        maxUnwedgeAttempts = 2,
        unwedgeReverseMs = 580,
        unwedgeForwardMs = 560,
        useInPageDepth = true,
        useMinimapOdometry = true,
        stopOnRaceFinish = true,
        unpause = true,
        unpauseButton = BTN.A,
        pause = true,
        pauseButton = BTN.START,
        unpauseSettleMs = 220,
        pauseSettleMs = 150,
        sampleIntervalMs = 180,
        stopOnStuck = true,
        stuckThreshold = 0.008,
        stuckDurationMs = 550,
        resetOnEnd = true,
        label = "servo"
      } = options;
      hideSheetOverlay();
      const eng = getEngine();
      const dEngine = getDepthEngine();
      eng.resetTracking();
      if (!unpause && typeof eng.resetRoadModel === "function") {
        eng.resetRoadModel();
      }
      const surface = eng.findVideoSurface();
      if (!surface) {
        return {
          ok: false,
          error: "No live video or canvas surface found",
          label,
          stopReason: "no_surface",
          durationMs: 0,
          framesCaptured: 0,
          avgMotion: 0,
          minMotion: 0,
          maxBannerDelta: 0,
          maxRedAlertRatio: 0,
          avgRoadConfidence: 0,
          meanSteerX: 0,
          meanCurvature: 0,
          stuckDetected: false,
          unwedgeCount: 0,
          raceFinished: false,
          depthFramesUsed: 0,
          finalState: gamepad.getState()
        };
      }
      const samples = [];
      let pidState = { prevError: 0, prevSteer: 0 };
      let stopReason = "horizon_complete";
      let stuckDetected = false;
      let raceFinished = false;
      let unwedgeCount = 0;
      let depthFramesUsed = 0;
      let lastSeenDepthTs = -1;
      let minimapHeadingDeg = null;
      let minimapTurnAhead = 0;
      let minimapDistance = 0;
      let errMsg;
      let ok = true;
      let prePauseSurface = null;
      const startedAt = performance.now();
      try {
        if (useInPageDepth && dEngine.getStatus().mode === "main_thread") {
          const preDepth = await dEngine.inferOnce(surface);
          if (preDepth) {
            lastSeenDepthTs = preDepth.timestamp;
            depthFramesUsed++;
          }
        }
        if (unpause) {
          await gamepad.tapButton(unpauseButton, 90, unpauseSettleMs);
        }
        gamepad.setButton(gasButton, 1);
        const driveStart = performance.now();
        let lastTick = driveStart;
        let lastTileAt = -Infinity;
        let lowMotionAcc = 0;
        let lowConfAcc = 0;
        let activeMotionTicks = 0;
        let finishConsecutiveTicks = 0;
        let tickIndex = 0;
        while (true) {
          const now = performance.now();
          const elapsed = now - driveStart;
          if (elapsed >= maxDurationMs) {
            stopReason = "horizon_complete";
            break;
          }
          const dtMs = Math.max(10, now - lastTick);
          lastTick = now;
          const analysis = eng.sampleAnalysis(surface);
          if (analysis.motionScore > 0.012) {
            activeMotionTicks++;
          }
          const rawDepth = useInPageDepth ? dEngine.submitFrameNonBlocking(surface) : null;
          const freshDepth = rawDepth && now - rawDepth.timestamp < 1800 ? rawDepth : null;
          if (freshDepth && freshDepth.timestamp !== lastSeenDepthTs) {
            lastSeenDepthTs = freshDepth.timestamp;
            depthFramesUsed++;
          }
          let visualTarget = analysis.roadOffsetX + (analysis.roadCurvature ?? 0) * 0.18;
          const mm = analysis.minimap;
          if (useMinimapOdometry && mm && mm.visible) {
            minimapHeadingDeg = mm.headingDeg;
            minimapDistance = mm.distance;
            if (mm.headingValid) {
              minimapTurnAhead = mm.turnAhead;
              const mmWeight = analysis.roadConfidence >= 0.45 ? 0.2 : 0.4;
              visualTarget = (1 - mmWeight) * visualTarget + mmWeight * clamp(mm.turnAhead, -1, 1);
            } else {
              minimapTurnAhead = 0;
            }
          }
          if (freshDepth) {
            const dWeight = freshDepth.wallOrObstacleAhead && freshDepth.centerClearance < 0.38 ? 0.78 : freshDepth.wallOrObstacleAhead || freshDepth.centerClearance < 0.52 ? 0.58 : 0.22;
            visualTarget = (1 - dWeight) * visualTarget + dWeight * clamp(freshDepth.corridorOffsetX, -1, 1);
          }
          if (typeof depthSteerHint === "number" && Number.isFinite(depthSteerHint)) {
            const w = clamp(depthHintWeight, 0, 1);
            visualTarget = (1 - w) * visualTarget + w * clamp(depthSteerHint, -1, 1);
          }
          const target = clamp(visualTarget + steerBias, -1, 1);
          const pid = computePidSteer(target, pidState, dtMs / 1000, kp, kd, maxSteer, 5.5);
          pidState = pid.nextState;
          gamepad.setStick(0, pid.steer, 0);
          if (throttleModulation && elapsed > 380) {
            const absSteer = Math.max(Math.abs(pid.steer), Math.abs(target) * 0.85);
            const absCurv = Math.abs(analysis.roadCurvature ?? 0);
            const confirmedTightCorner = Math.abs(analysis.roadOffsetX) > 0.48 || absCurv > 0.34 || freshDepth !== null && freshDepth.centerClearance < 0.42;
            if (autoCornerBrake && elapsed > 1100 && analysis.motionScore > 0.042 && absSteer > 0.84 && confirmedTightCorner) {
              gamepad.setButton(gasButton, 0);
              gamepad.setButton(BTN.X, tickIndex % 3 === 0 ? 1 : 0);
            } else if (absSteer > 0.68 || absCurv > 0.3) {
              gamepad.setButton(BTN.X, 0);
              gamepad.setButton(gasButton, tickIndex % 3 === 0 ? 1 : 0);
            } else if (absSteer > 0.44 || absCurv > 0.18 || freshDepth !== null && freshDepth.centerClearance < 0.52) {
              gamepad.setButton(BTN.X, 0);
              gamepad.setButton(gasButton, tickIndex % 2 === 0 ? 1 : 0);
            } else {
              gamepad.setButton(BTN.X, 0);
              gamepad.setButton(gasButton, 1);
            }
          } else {
            gamepad.setButton(BTN.X, 0);
            gamepad.setButton(gasButton, 1);
          }
          tickIndex++;
          const state = gamepad.getState();
          if (now - lastTileAt >= sampleIntervalMs) {
            lastTileAt = now;
            samples.push(eng.captureTile(surface, elapsed, state.axes, state.buttons, analysis, 320, 240, freshDepth));
          }
          if (stopOnRaceFinish && elapsed > 1200 && activeMotionTicks >= 4) {
            if (analysis.raceFinishedCandidate) {
              finishConsecutiveTicks++;
              if (finishConsecutiveTicks >= 4) {
                raceFinished = true;
                stopReason = "race_finished";
                gamepad.resetAll();
                await gamepad.sleep(200);
                break;
              }
            } else {
              finishConsecutiveTicks = 0;
            }
          }
          if (elapsed > 350) {
            const pinnedAgainst3DObstacle = freshDepth !== null && freshDepth.wallOrObstacleAhead && freshDepth.centerClearance < 0.22 && analysis.motionScore < Math.max(stuckThreshold, 0.03);
            if (stopOnStuck && (analysis.motionScore < stuckThreshold || pinnedAgainst3DObstacle)) {
              lowMotionAcc += dtMs;
              if (lowMotionAcc >= stuckDurationMs) {
                if (autoUnwedge && unwedgeCount < maxUnwedgeAttempts) {
                  unwedgeCount++;
                  lowMotionAcc = 0;
                  lowConfAcc = 0;
                  let uwDepth = freshDepth;
                  if (useInPageDepth && !uwDepth && dEngine.getStatus().mode === "main_thread") {
                    uwDepth = await dEngine.inferOnce(surface);
                    if (uwDepth && uwDepth.timestamp !== lastSeenDepthTs) {
                      lastSeenDepthTs = uwDepth.timestamp;
                      depthFramesUsed++;
                    }
                  }
                  let escapeSign = unwedgeCount % 2 === 1 ? 1 : -1;
                  if (uwDepth && Math.abs(uwDepth.corridorOffsetX) > 0.12) {
                    escapeSign = Math.sign(uwDepth.corridorOffsetX);
                  } else if (useMinimapOdometry && mm?.visible && mm.headingValid && Math.abs(mm.turnAhead) > 0.12) {
                    escapeSign = Math.sign(mm.turnAhead);
                  } else if (Math.abs(analysis.roadOffsetX) > 0.08) {
                    escapeSign = Math.sign(analysis.roadOffsetX);
                  }
                  gamepad.setButton(gasButton, 0);
                  gamepad.setStick(0, 0, 0);
                  gamepad.setButton(BTN.X, 1);
                  await gamepad.sleep(unwedgeReverseMs);
                  gamepad.setButton(BTN.X, 0);
                  await gamepad.sleep(40);
                  if (typeof eng.resetRoadModel === "function") {
                    eng.resetRoadModel();
                  }
                  gamepad.setStick(0, 0.78 * escapeSign, 0);
                  gamepad.setButton(gasButton, 1);
                  await gamepad.sleep(unwedgeForwardMs);
                  const uwAnalysis = eng.sampleAnalysis(surface);
                  const uwState = gamepad.getState();
                  lastTileAt = performance.now();
                  samples.push(eng.captureTile(surface, lastTileAt - driveStart, uwState.axes, uwState.buttons, uwAnalysis, 320, 240, uwDepth));
                  pidState = { prevError: 0, prevSteer: 0.5 * escapeSign };
                  lastTick = performance.now();
                  lowMotionAcc = 0;
                  lowConfAcc = 0;
                  continue;
                }
                stuckDetected = true;
                stopReason = "stuck";
                break;
              }
            } else {
              lowMotionAcc = 0;
            }
            if (stopOnRedAlert && analysis.redAlertRatio >= redAlertThreshold) {
              stopReason = "red_alert";
              break;
            }
            if (stopOnBannerChange && elapsed > 500 && analysis.bannerDelta >= bannerDeltaThreshold) {
              stopReason = "banner_changed";
              break;
            }
            if (stopOnLowConfidence && analysis.roadConfidence < minConfidence) {
              const depthConfirmsTrack = freshDepth !== null && freshDepth.maxClearance >= 0.48;
              const minimapConfirmsTrack = useMinimapOdometry && Boolean(mm?.visible && mm.onRibbon && mm.headingValid);
              const effectiveLowConfMs = depthConfirmsTrack || minimapConfirmsTrack ? lowConfidenceMs * 2.2 : lowConfidenceMs;
              if (depthConfirmsTrack && freshDepth.centerClearance > 0.55 && Math.abs(target) < 0.25 && typeof eng.resetRoadModel === "function") {
                eng.resetRoadModel();
              }
              lowConfAcc += dtMs;
              if (lowConfAcc >= effectiveLowConfMs) {
                stopReason = "low_confidence";
                break;
              }
            } else {
              lowConfAcc = 0;
            }
          }
          await gamepad.sleep(tickMs);
        }
        const finalAnalysis = eng.sampleAnalysis(surface);
        const finalSnap = gamepad.getState();
        const latestDepth = useInPageDepth ? dEngine.getStatus().lastResult : null;
        samples.push(eng.captureTile(surface, performance.now() - driveStart, finalSnap.axes, finalSnap.buttons, finalAnalysis, 320, 240, latestDepth));
      } catch (err) {
        ok = false;
        stopReason = "error";
        errMsg = err instanceof Error ? err.message : String(err);
      } finally {
        if (surface && typeof eng.captureFullFrame === "function") {
          try {
            prePauseSurface = eng.captureFullFrame(surface);
          } catch {}
        }
        if (resetOnEnd) {
          gamepad.resetAll();
        }
        if (pause && !raceFinished) {
          try {
            await gamepad.tapButton(pauseButton, 90, pauseSettleMs);
          } catch {}
          if (resetOnEnd) {
            gamepad.resetAll();
          }
        }
      }
      const durationMs = performance.now() - startedAt;
      return summarizeSamples(samples, label, stopReason, durationMs, stuckDetected, ok, errMsg, false, prePauseSurface ?? surface, options, {
        unwedgeCount,
        raceFinished,
        depthFramesUsed,
        minimapHeadingDeg,
        minimapTurnAhead,
        minimapDistance
      });
    }
    async function smartRescue(options = {}) {
      return runChunk(async ({ api }) => {
        await api.tapButton(BTN.BACK, 180, 1400);
      }, {
        ...options,
        stopOnStuck: false,
        label: options.label ?? "rescue"
      });
    }
    async function coverPeekBurst(options = {}) {
      const {
        aimButton = BTN.LT,
        fireButton = BTN.RT,
        coverButton = BTN.RB,
        enterCover = false,
        aimSettleMs = 180,
        aimX = 0,
        aimY = 0,
        aimNudgeMs = 0,
        bursts = 2,
        burstMs = 220,
        gapMs = 120,
        special = false,
        unpause = false,
        pause = false,
        stopOnStuck = false,
        label = "cover-peek",
        ...rest
      } = options;
      return runChunk(async ({ api, shouldAbort }) => {
        if (special) {
          api.setButton(BTN.L3, 1);
          api.setButton(BTN.R3, 1);
          await api.sleep(90);
          api.setButton(BTN.L3, 0);
          api.setButton(BTN.R3, 0);
          await api.sleep(80);
        }
        if (enterCover) {
          await api.tapButton(coverButton, 80, 140);
        }
        api.setButton(aimButton, 1);
        await api.sleep(aimSettleMs);
        if (aimNudgeMs > 0 && (aimX !== 0 || aimY !== 0)) {
          api.setStick(1, aimX, aimY);
          await api.sleep(aimNudgeMs);
          api.setStick(1, 0, 0);
        }
        for (let i = 0;i < bursts && !shouldAbort(); i++) {
          api.setButton(fireButton, 1);
          await api.sleep(burstMs);
          api.setButton(fireButton, 0);
          if (i + 1 < bursts && gapMs > 0) {
            await api.sleep(gapMs);
          }
        }
        api.setStick(1, 0, 0);
        api.setButton(fireButton, 0);
        api.setButton(aimButton, 0);
        await api.sleep(100);
      }, {
        ...rest,
        unpause,
        pause,
        stopOnStuck,
        label
      });
    }
    async function sprintMove(options = {}) {
      const {
        yawX = 0,
        yawY = 0,
        yawMs = 0,
        moveX = 0,
        moveY = -1,
        sprint = true,
        sprintButton = BTN.A,
        durationMs = 1200,
        endCover = false,
        coverButton = BTN.RB,
        unpause = false,
        pause = false,
        label = "sprint-move",
        ...rest
      } = options;
      return runChunk(async ({ api, shouldAbort }) => {
        if (yawMs > 0 && (yawX !== 0 || yawY !== 0)) {
          api.setStick(1, yawX, yawY);
          await api.sleep(yawMs);
          api.setStick(1, 0, 0);
          await api.sleep(50);
        }
        api.setStick(0, moveX, moveY);
        if (sprint) {
          api.setButton(sprintButton, 1);
        }
        const stepMs = 150;
        const steps = Math.max(1, Math.ceil(durationMs / stepMs));
        for (let i = 0;i < steps && !shouldAbort(); i++) {
          await api.sleep(Math.min(stepMs, Math.max(50, durationMs - i * stepMs)));
        }
        if (sprint) {
          api.setButton(sprintButton, 0);
        }
        api.setStick(0, 0, 0);
        if (endCover) {
          await api.tapButton(coverButton, 80, 120);
        }
      }, {
        ...rest,
        unpause,
        pause,
        label
      });
    }
    function inspectFrame() {
      const eng = getEngine();
      const dEngine = getDepthEngine();
      const surface = eng.findVideoSurface();
      if (!surface) {
        return {
          foundSurface: false,
          width: 0,
          height: 0,
          motionScore: 0,
          bannerDelta: 0,
          redAlertRatio: 0,
          roadOffsetX: 0,
          roadCurvature: 0,
          roadConfidence: 0,
          depth: dEngine.getStatus()
        };
      }
      const dims = eng.getSurfaceDimensions(surface);
      const analysis = eng.sampleAnalysis(surface, false);
      return {
        foundSurface: true,
        width: dims.w,
        height: dims.h,
        motionScore: analysis.motionScore,
        bannerDelta: analysis.bannerDelta,
        redAlertRatio: analysis.redAlertRatio,
        roadOffsetX: analysis.roadOffsetX,
        roadCurvature: analysis.roadCurvature,
        roadConfidence: analysis.roadConfidence,
        minimap: analysis.minimap,
        depth: dEngine.getStatus()
      };
    }
    function readGtavRadar() {
      const eng = getEngine();
      const surface = eng.findVideoSurface();
      if (!surface || typeof eng.readGtavRadar !== "function")
        return null;
      return eng.readGtavRadar(surface);
    }
    async function autoCombatSweep(options = {}) {
      const {
        aimButton = BTN.LT,
        fireButton = BTN.RT,
        coverButton = BTN.RB,
        enterCover = false,
        maxDurationMs = 3500,
        maxCycles = 4,
        aimSettleMs = 160,
        burstMs = 220,
        duckMs = 180,
        special = false,
        autoSpecialOnLowHealth = true,
        unpause = false,
        pause = false,
        stopOnStuck = false,
        label = "combat-sweep",
        ...rest
      } = options;
      return runChunk(async ({ api, shouldAbort }) => {
        const eng = getEngine();
        const surface = eng.findVideoSurface();
        let specialUsed = false;
        const startAt = performance.now();
        const triggerSpecial = async () => {
          specialUsed = true;
          api.setButton(BTN.L3, 1);
          api.setButton(BTN.R3, 1);
          await api.sleep(90);
          api.setButton(BTN.L3, 0);
          api.setButton(BTN.R3, 0);
          await api.sleep(60);
        };
        if (special) {
          await triggerSpecial();
        }
        if (enterCover) {
          await api.tapButton(coverButton, 80, 120);
        }
        for (let i = 0;i < maxCycles && !shouldAbort(); i++) {
          if (performance.now() - startAt >= maxDurationMs)
            break;
          const radar = surface && typeof eng.readGtavRadar === "function" ? eng.readGtavRadar(surface) : null;
          if (radar && radar.lowHealth) {
            if (autoSpecialOnLowHealth && !specialUsed) {
              await triggerSpecial();
            } else {
              break;
            }
          }
          api.setButton(aimButton, 1);
          await api.sleep(aimSettleMs);
          api.setButton(fireButton, 1);
          await api.sleep(burstMs);
          api.setButton(fireButton, 0);
          api.setButton(aimButton, 0);
          if (i + 1 < maxCycles && duckMs > 0) {
            await api.sleep(duckMs);
          }
        }
        api.setButton(fireButton, 0);
        api.setButton(aimButton, 0);
      }, {
        ...rest,
        unpause,
        pause,
        stopOnStuck,
        label
      });
    }
    return {
      runChunk,
      driveServo,
      smartRescue,
      coverPeekBurst,
      sprintMove,
      autoCombatSweep,
      readGtavRadar,
      getRecentHistory,
      hideOverlay: hideSheetOverlay,
      resetRoadModel,
      initDepthEngine,
      getDepthStatus,
      inspectFrame
    };
  }

  // packages/runtime/index.ts
  var gamepad = createGamepadController();
  var orchestrator = createGameplayOrchestrator(gamepad);
  var gameplayApi = {
    version: "5.0.1",
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
    coverPeekBurst: orchestrator.coverPeekBurst,
    sprintMove: orchestrator.sprintMove,
    autoCombatSweep: orchestrator.autoCombatSweep,
    readGtavRadar: orchestrator.readGtavRadar,
    getRecentHistory: orchestrator.getRecentHistory,
    hideOverlay: hideSheetOverlay,
    resetRoadModel: orchestrator.resetRoadModel,
    initDepthEngine: orchestrator.initDepthEngine,
    getDepthStatus: orchestrator.getDepthStatus,
    inspectFrame: orchestrator.inspectFrame
  };
  window["gameplayApi"] = gameplayApi;
  console.log("Gameplay - hooked v5.0.1 (in-page 3D depth worker + 30Hz minimap odometry + autoUnwedge + finish detection)");
})();
