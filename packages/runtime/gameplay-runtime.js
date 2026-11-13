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
  function createGamepadController(targetWindow = window, targetNavigator = navigator, targetDocument = typeof document !== "undefined" ? document : undefined) {
    const gamepadAxes = [0, 0, 0, 0];
    const gamepadButtons = Array.from({ length: 17 }, () => ({
      value: 0,
      pressed: false,
      touched: false
    }));
    const simGamepad = {
      id: "Gameplay - SimGamepad",
      index: 0,
      connected: true,
      timestamp: Date.now(),
      axes: gamepadAxes,
      buttons: gamepadButtons,
      vibrationActuator: undefined,
      mapping: "standard"
    };
    function hookGetGamepads() {
      return [simGamepad];
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
      simGamepad.timestamp = Date.now();
    }
    function dispatchConnected() {
      const event = new Event("gamepadconnected");
      event.gamepad = simGamepad;
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
      setButton,
      tapButton,
      rampStick,
      sleep,
      resetAll,
      getState,
      dispatchConnected
    };
  }

  // packages/runtime/src/vision.ts
  var DEFAULT_STK_CROPS = [
    { label: "MINIMAP", x: 0, y: 0.56, w: 0.25, h: 0.42 },
    { label: "TUTORIAL PROMPT", x: 0.2, y: 0.8, w: 0.6, h: 0.19 },
    { label: "TOP HUD", x: 0.16, y: 0.02, w: 0.68, h: 0.28 }
  ];
  function createInitialRoadModel() {
    return { r: 120, g: 115, b: 110, initialized: false };
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
    let redAlertPixels = 0;
    {
      const xStart = Math.floor(width * 0.15);
      const xEnd = Math.floor(width * 0.85);
      const yStart = Math.floor(height * 0.05);
      const yEnd = Math.floor(height * 0.34);
      for (let y = yStart;y < yEnd; y += 2) {
        for (let x = xStart;x < xEnd; x += 2) {
          const idx = (y * width + x) * 4;
          const r = rgba[idx];
          const g = rgba[idx + 1];
          const b = rgba[idx + 2];
          if (r > 175 && r - g > 65 && r - b > 65) {
            redAlertPixels++;
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
    const redAlertRatio = bannerPixels > 0 ? redAlertPixels / bannerPixels : 0;
    let seedR = 0;
    let seedG = 0;
    let seedB = 0;
    let seedCount = 0;
    {
      const yStart = Math.floor(height * 0.58);
      const yEnd = Math.floor(height * 0.67);
      const xStart = Math.floor(width * 0.38);
      const xEnd = Math.floor(width * 0.62);
      for (let y = yStart;y < yEnd; y += 2) {
        for (let x = xStart;x < xEnd; x += 2) {
          const idx = (y * width + x) * 4;
          const r = rgba[idx];
          const g = rgba[idx + 1];
          const b = rgba[idx + 2];
          const greenExcess = g - Math.max(r, b);
          const lum = (r + g + b) / 3;
          if (greenExcess < 22 && lum > 25 && lum < 245) {
            seedR += r;
            seedG += g;
            seedB += b;
            seedCount++;
          }
        }
      }
    }
    let nextModel = { ...roadModel };
    if (seedCount >= 8) {
      const avgR = seedR / seedCount;
      const avgG = seedG / seedCount;
      const avgB = seedB / seedCount;
      if (!nextModel.initialized) {
        nextModel = { r: avgR, g: avgG, b: avgB, initialized: true };
      } else {
        const alpha = 0.15;
        nextModel = {
          r: nextModel.r * (1 - alpha) + avgR * alpha,
          g: nextModel.g * (1 - alpha) + avgG * alpha,
          b: nextModel.b * (1 - alpha) + avgB * alpha,
          initialized: true
        };
      }
    }
    const numCols = 24;
    const rawColScores = new Float64Array(numCols);
    const lookRows = [
      Math.floor(height * 0.45),
      Math.floor(height * 0.52),
      Math.floor(height * 0.59)
    ];
    const refRG = nextModel.r - nextModel.g;
    const refGB = nextModel.g - nextModel.b;
    const refLum = (nextModel.r + nextModel.g + nextModel.b) / 3;
    const xMargin = Math.floor(width * 0.08);
    const spanW = width - 2 * xMargin;
    for (let c = 0;c < numCols; c++) {
      const x0 = xMargin + Math.floor(c / numCols * spanW);
      const x1 = Math.max(x0 + 1, xMargin + Math.floor((c + 1) / numCols * spanW));
      let colScoreSum = 0;
      let colSamples = 0;
      for (let rIdx = 0;rIdx < lookRows.length; rIdx++) {
        const y = lookRows[rIdx];
        for (let x = x0;x < x1; x++) {
          const idx = (y * width + x) * 4;
          const r = rgba[idx];
          const g = rgba[idx + 1];
          const b = rgba[idx + 2];
          const rg = r - g;
          const gb = g - b;
          const lum = (r + g + b) / 3;
          const chromaDiff = (Math.abs(rg - refRG) + Math.abs(gb - refGB)) / 510;
          const lumDiff = Math.abs(lum - refLum) / 255;
          const colorDist = chromaDiff * 0.68 + lumDiff * 0.32;
          const rightIdx = (y * width + Math.min(width - 1, x + 1)) * 4;
          const edge = (Math.abs(r - rgba[rightIdx]) + Math.abs(g - rgba[rightIdx + 1]) + Math.abs(b - rgba[rightIdx + 2])) / (3 * 255);
          const greenPenalty = Math.max(0, (g - Math.max(r, b) - 10) / 60);
          const skyPenalty = rIdx === 0 && b - r > 22 && lum > 130 ? 0.8 : 0;
          const redWallPenalty = r - g > 65 ? 0.5 : 0;
          const pixelScore = Math.max(0, 1 - (colorDist * 2.1 + edge * 0.9 + greenPenalty + skyPenalty + redWallPenalty));
          colScoreSum += pixelScore;
          colSamples++;
        }
      }
      rawColScores[c] = colSamples > 0 ? colScoreSum / colSamples : 0;
    }
    const colScores = new Float64Array(numCols);
    for (let c = 0;c < numCols; c++) {
      const left = c > 0 ? rawColScores[c - 1] : rawColScores[c];
      const right = c < numCols - 1 ? rawColScores[c + 1] : rawColScores[c];
      colScores[c] = 0.25 * left + 0.5 * rawColScores[c] + 0.25 * right;
    }
    let weightSum = 0;
    let weightedPos = 0;
    let maxColScore = 0;
    let totalColScore = 0;
    for (let c = 0;c < numCols; c++) {
      const s = colScores[c];
      totalColScore += s;
      if (s > maxColScore)
        maxColScore = s;
      const normX = (c + 0.5) / numCols * 2 - 1;
      const w = s * s;
      weightSum += w;
      weightedPos += w * normX;
    }
    const roadOffsetX = weightSum > 0.0001 ? weightedPos / weightSum : 0;
    const meanScore = totalColScore / numCols;
    const roadConfidence = Math.min(1, maxColScore * 0.65 + meanScore * 0.55);
    return {
      motionScore,
      bannerDelta,
      redAlertRatio,
      roadOffsetX,
      roadConfidence,
      updatedRoadModel: nextModel
    };
  }

  class VideoCaptureEngine {
    analysisCanvas;
    analysisCtx;
    prevAnalysisRgba = null;
    roadModel = createInitialRoadModel();
    analysisW = 160;
    analysisH = 120;
    constructor() {
      this.analysisCanvas = document.createElement("canvas");
      this.analysisCanvas.width = this.analysisW;
      this.analysisCanvas.height = this.analysisH;
      const ctx = this.analysisCanvas.getContext("2d", { willReadFrequently: true });
      if (!ctx)
        throw new Error("Failed to initialize 2D analysis canvas context");
      this.analysisCtx = ctx;
    }
    resetTracking() {
      this.prevAnalysisRgba = null;
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
    sampleAnalysis(surface) {
      this.analysisCtx.drawImage(surface, 0, 0, this.analysisW, this.analysisH);
      const img = this.analysisCtx.getImageData(0, 0, this.analysisW, this.analysisH);
      const rgba = new Uint8ClampedArray(img.data);
      const analysis = analyzeRgbaFrame(rgba, this.prevAnalysisRgba, this.analysisW, this.analysisH, this.roadModel);
      this.prevAnalysisRgba = rgba;
      this.roadModel = analysis.updatedRoadModel;
      return analysis;
    }
    captureTile(surface, tMs, axes, buttons, analysis, tileW = 320, tileH = 240) {
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
        roadConfidence: analysis.roadConfidence
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
    const headerText = `${summary.label} | stop=${summary.stopReason} | ${Math.round(summary.durationMs)}ms | avgΔ=${(summary.avgMotion * 100).toFixed(1)}% | roadConf=${(summary.avgRoadConfidence * 100).toFixed(0)}%`;
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
        ctx.fillStyle = "rgba(15, 23, 42, 0.8)";
        ctx.fillRect(dx + 4, stripY + 4, 140, 20);
        ctx.fillStyle = "#38bdf8";
        ctx.font = "bold 12px ui-monospace, Menlo, monospace";
        ctx.fillText(`FINAL ${c.label}`, dx + 10, stripY + 18);
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
  function createGameplayOrchestrator(gamepad, captureEngine) {
    let engine = captureEngine ?? null;
    function getEngine() {
      if (!engine)
        engine = new VideoCaptureEngine;
      return engine;
    }
    function summarizeSamples(samples, label, stopReason, durationMs, stuckDetected, ok, error, includeSheetDataUrl = false, surface = null, options = {}) {
      const count = samples.length;
      let sumMotion = 0;
      let minMotion = count > 1 ? Infinity : 0;
      let maxBannerDelta = 0;
      let maxRedAlertRatio = 0;
      let sumConf = 0;
      let sumSteer = 0;
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
      }
      const avgMotion = count > 1 ? sumMotion / (count - 1) : 0;
      const avgRoadConfidence = count > 0 ? sumConf / count : 0;
      const meanSteerX = count > 0 ? sumSteer / count : 0;
      let sheetDataUrl;
      if (count > 0 && (options.showSheetOverlay ?? true)) {
        const sheet = buildContactSheetCanvas(samples, surface, { label, stopReason, durationMs, avgMotion, avgRoadConfidence }, options.crops ?? DEFAULT_STK_CROPS);
        showSheetOverlay(sheet);
        if (includeSheetDataUrl) {
          sheetDataUrl = sheet.toDataURL("image/jpeg", 0.82);
        }
      }
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
        stuckDetected,
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
        if (pause) {
          try {
            await gamepad.tapButton(pauseButton, 90, pauseSettleMs);
          } catch {}
        }
        if (resetOnEnd) {
          gamepad.resetAll();
        }
      }
      const durationMs = performance.now() - startedAt;
      return summarizeSamples(samples, label, stopReason, durationMs, stuckDetected, ok, errMsg, false, surface, options);
    }
    async function driveServo(options = {}) {
      const {
        maxDurationMs = 3000,
        tickMs = 33,
        kp = 0.95,
        kd = 0.22,
        maxSteer = 0.85,
        gasButton = BTN.Y,
        steerBias = 0,
        stopOnBannerChange = false,
        bannerDeltaThreshold = 0.28,
        stopOnLowConfidence = true,
        minConfidence = 0.2,
        lowConfidenceMs = 350,
        stopOnRedAlert = true,
        redAlertThreshold = 0.035,
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
      eng.resetTracking();
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
          stuckDetected: false,
          finalState: gamepad.getState()
        };
      }
      const samples = [];
      let pidState = { prevError: 0, prevSteer: 0 };
      let stopReason = "horizon_complete";
      let stuckDetected = false;
      let errMsg;
      let ok = true;
      const startedAt = performance.now();
      try {
        if (unpause) {
          await gamepad.tapButton(unpauseButton, 90, unpauseSettleMs);
        }
        gamepad.setButton(gasButton, 1);
        const driveStart = performance.now();
        let lastTick = driveStart;
        let lastTileAt = -Infinity;
        let lowMotionAcc = 0;
        let lowConfAcc = 0;
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
          const target = clamp(analysis.roadOffsetX + steerBias, -1, 1);
          const pid = computePidSteer(target, pidState, dtMs / 1000, kp, kd, maxSteer);
          pidState = pid.nextState;
          gamepad.setStick(0, pid.steer, 0);
          const state = gamepad.getState();
          if (now - lastTileAt >= sampleIntervalMs) {
            lastTileAt = now;
            samples.push(eng.captureTile(surface, elapsed, state.axes, state.buttons, analysis));
          }
          if (elapsed > 350) {
            if (stopOnStuck && analysis.motionScore < stuckThreshold) {
              lowMotionAcc += dtMs;
              if (lowMotionAcc >= stuckDurationMs) {
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
              lowConfAcc += dtMs;
              if (lowConfAcc >= lowConfidenceMs) {
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
        samples.push(eng.captureTile(surface, performance.now() - driveStart, finalSnap.axes, finalSnap.buttons, finalAnalysis));
      } catch (err) {
        ok = false;
        stopReason = "error";
        errMsg = err instanceof Error ? err.message : String(err);
      } finally {
        if (pause) {
          try {
            await gamepad.tapButton(pauseButton, 90, pauseSettleMs);
          } catch {}
        }
        if (resetOnEnd) {
          gamepad.resetAll();
        }
      }
      const durationMs = performance.now() - startedAt;
      return summarizeSamples(samples, label, stopReason, durationMs, stuckDetected, ok, errMsg, false, surface, options);
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
    function inspectFrame() {
      const eng = getEngine();
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
          roadConfidence: 0
        };
      }
      const dims = eng.getSurfaceDimensions(surface);
      const analysis = eng.sampleAnalysis(surface);
      return {
        foundSurface: true,
        width: dims.w,
        height: dims.h,
        motionScore: analysis.motionScore,
        bannerDelta: analysis.bannerDelta,
        redAlertRatio: analysis.redAlertRatio,
        roadOffsetX: analysis.roadOffsetX,
        roadConfidence: analysis.roadConfidence
      };
    }
    return {
      runChunk,
      driveServo,
      smartRescue,
      hideOverlay: hideSheetOverlay,
      inspectFrame
    };
  }

  // packages/runtime/index.ts
  var gamepad = createGamepadController();
  var orchestrator = createGameplayOrchestrator(gamepad);
  var gameplayApi = {
    BTN,
    simGamepad: gamepad.simGamepad,
    setStick: gamepad.setStick,
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
    inspectFrame: orchestrator.inspectFrame
  };
  window["gameplayApi"] = gameplayApi;
  console.log("Gameplay - hooked v2 (gamepad + servo + contact-sheet)");
})();
