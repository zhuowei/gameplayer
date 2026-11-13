import type { CropRegion, FrameSample } from "./types";

export interface RoadColorModel {
  r: number;
  g: number;
  b: number;
  initialized: boolean;
}

export interface FrameAnalysis {
  motionScore: number;
  bannerDelta: number;
  redAlertRatio: number;
  roadOffsetX: number;
  roadConfidence: number;
  updatedRoadModel: RoadColorModel;
}

export const DEFAULT_STK_CROPS: CropRegion[] = [
  { label: "MINIMAP", x: 0.0, y: 0.62, w: 0.24, h: 0.36 },
  { label: "HUD / PROMPT", x: 0.14, y: 0.02, w: 0.72, h: 0.28 },
];

export function createInitialRoadModel(): RoadColorModel {
  return { r: 120, g: 115, b: 110, initialized: false };
}

/**
 * Pure pixel analysis on an RGBA buffer (small analysis resolution, e.g. 160x120).
 * Operates strictly on rendered video pixels with zero game internals.
 */
export function analyzeRgbaFrame(
  rgba: Uint8ClampedArray,
  prevRgba: Uint8ClampedArray | null,
  width: number,
  height: number,
  roadModel: RoadColorModel = createInitialRoadModel(),
): FrameAnalysis {
  // 1. Motion score on mid-track ROI (x: 12%..88%, y: 35%..80%)
  let motionSum = 0;
  let motionCount = 0;
  if (prevRgba && prevRgba.length === rgba.length) {
    const xStart = Math.floor(width * 0.12);
    const xEnd = Math.floor(width * 0.88);
    const yStart = Math.floor(height * 0.35);
    const yEnd = Math.floor(height * 0.8);
    for (let y = yStart; y < yEnd; y += 2) {
      for (let x = xStart; x < xEnd; x += 2) {
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

  // 2. Top-center banner delta & red alert ratio (x: 15%..85%, y: 5%..32%)
  let bannerChanged = 0;
  let bannerPixels = 0;
  let redAlertPixels = 0;
  {
    const xStart = Math.floor(width * 0.15);
    const xEnd = Math.floor(width * 0.85);
    const yStart = Math.floor(height * 0.05);
    const yEnd = Math.floor(height * 0.34);
    for (let y = yStart; y < yEnd; y += 2) {
      for (let x = xStart; x < xEnd; x += 2) {
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        if (r > 175 && r - g > 65 && r - b > 65) {
          redAlertPixels++;
        }
        if (prevRgba && prevRgba.length === rgba.length) {
          const lum = 0.299 * r + 0.587 * g + 0.114 * b;
          const prevLum =
            0.299 * prevRgba[idx] +
            0.587 * prevRgba[idx + 1] +
            0.114 * prevRgba[idx + 2];
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

  // 3. Seed/update foreground road prototype from immediate ahead zone
  // Sample two patches flanking center-ahead (y: 62%..70%, x: 35%..43% and 57%..65% plus nose 59%..65%)
  let seedR = 0;
  let seedG = 0;
  let seedB = 0;
  let seedCount = 0;
  {
    const yStart = Math.floor(height * 0.58);
    const yEnd = Math.floor(height * 0.67);
    const xStart = Math.floor(width * 0.38);
    const xEnd = Math.floor(width * 0.62);
    for (let y = yStart; y < yEnd; y += 2) {
      for (let x = xStart; x < xEnd; x += 2) {
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        const greenExcess = g - Math.max(r, b);
        const lum = (r + g + b) / 3;
        // Skip obvious neon grass or pitch-black occlusion shadows when seeding road model
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
      // Gentle EMA adaptation for transitions (stone -> dirt -> wood bridge -> tunnel)
      const alpha = 0.15;
      nextModel = {
        r: nextModel.r * (1 - alpha) + avgR * alpha,
        g: nextModel.g * (1 - alpha) + avgG * alpha,
        b: nextModel.b * (1 - alpha) + avgB * alpha,
        initialized: true,
      };
    }
  }

  // 4. Evaluate navigability across 24 columns in lookahead band (y: 44%..62%)
  const numCols = 24;
  const rawColScores = new Float64Array(numCols);
  const lookRows = [
    Math.floor(height * 0.45),
    Math.floor(height * 0.52),
    Math.floor(height * 0.59),
  ];

  const refRG = nextModel.r - nextModel.g;
  const refGB = nextModel.g - nextModel.b;
  const refLum = (nextModel.r + nextModel.g + nextModel.b) / 3;

  const xMargin = Math.floor(width * 0.08);
  const spanW = width - 2 * xMargin;

  for (let c = 0; c < numCols; c++) {
    const x0 = xMargin + Math.floor((c / numCols) * spanW);
    const x1 = Math.max(x0 + 1, xMargin + Math.floor(((c + 1) / numCols) * spanW));
    let colScoreSum = 0;
    let colSamples = 0;

    for (let rIdx = 0; rIdx < lookRows.length; rIdx++) {
      const y = lookRows[rIdx];
      // Weight slightly closer lookahead rows more weakly than mid-horizon to anticipate curves
      for (let x = x0; x < x1; x++) {
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

        // Horizontal edge gradient (walls/fences/trees tend to have higher local edges)
        const rightIdx = (y * width + Math.min(width - 1, x + 1)) * 4;
        const edge =
          (Math.abs(r - rgba[rightIdx]) +
            Math.abs(g - rgba[rightIdx + 1]) +
            Math.abs(b - rgba[rightIdx + 2])) /
          (3 * 255);

        const greenPenalty = Math.max(0, (g - Math.max(r, b) - 10) / 60);
        const skyPenalty = rIdx === 0 && b - r > 22 && lum > 130 ? 0.8 : 0;
        const redWallPenalty = r - g > 65 ? 0.5 : 0;

        const pixelScore = Math.max(
          0,
          1 - (colorDist * 2.1 + edge * 0.9 + greenPenalty + skyPenalty + redWallPenalty),
        );
        colScoreSum += pixelScore;
        colSamples++;
      }
    }

    rawColScores[c] = colSamples > 0 ? colScoreSum / colSamples : 0;
  }

  // Smooth column scores [0.25, 0.5, 0.25]
  const colScores = new Float64Array(numCols);
  for (let c = 0; c < numCols; c++) {
    const left = c > 0 ? rawColScores[c - 1] : rawColScores[c];
    const right = c < numCols - 1 ? rawColScores[c + 1] : rawColScores[c];
    colScores[c] = 0.25 * left + 0.5 * rawColScores[c] + 0.25 * right;
  }

  // Weighted centroid of top scoring navigable columns (squared weights sharpen lane peak)
  let weightSum = 0;
  let weightedPos = 0;
  let maxColScore = 0;
  let totalColScore = 0;

  for (let c = 0; c < numCols; c++) {
    const s = colScores[c];
    totalColScore += s;
    if (s > maxColScore) maxColScore = s;
    const normX = ((c + 0.5) / numCols) * 2 - 1; // [-1 .. +1]
    // Slightly prefer gentle center continuity unless blocked
    const w = s * s;
    weightSum += w;
    weightedPos += w * normX;
  }

  const roadOffsetX = weightSum > 1e-4 ? weightedPos / weightSum : 0;
  const meanScore = totalColScore / numCols;
  const roadConfidence = Math.min(1, maxColScore * 0.65 + meanScore * 0.55);

  return {
    motionScore,
    bannerDelta,
    redAlertRatio,
    roadOffsetX,
    roadConfidence,
    updatedRoadModel: nextModel,
  };
}

export class VideoCaptureEngine {
  private analysisCanvas: HTMLCanvasElement;
  private analysisCtx: CanvasRenderingContext2D;
  private prevAnalysisRgba: Uint8ClampedArray | null = null;
  private roadModel: RoadColorModel = createInitialRoadModel();
  private readonly analysisW = 160;
  private readonly analysisH = 120;

  constructor() {
    this.analysisCanvas = document.createElement("canvas");
    this.analysisCanvas.width = this.analysisW;
    this.analysisCanvas.height = this.analysisH;
    const ctx = this.analysisCanvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("Failed to initialize 2D analysis canvas context");
    this.analysisCtx = ctx;
  }

  resetTracking(): void {
    this.prevAnalysisRgba = null;
  }

  resetRoadModel(): void {
    this.roadModel = createInitialRoadModel();
  }

  findVideoSurface(): HTMLCanvasElement | HTMLVideoElement | null {
    let bestEl: HTMLCanvasElement | HTMLVideoElement | null = null;
    let bestArea = 0;

    const canvases = Array.from(document.querySelectorAll("canvas"));
    for (const c of canvases) {
      if (c.dataset.gameplayOverlay === "true") continue;
      if (c.width < 200 || c.height < 150) continue;
      const area = c.width * c.height;
      if (area > bestArea) {
        bestArea = area;
        bestEl = c;
      }
    }

    const videos = Array.from(document.querySelectorAll("video"));
    for (const v of videos) {
      if (v.videoWidth < 200 || v.videoHeight < 150) continue;
      const area = v.videoWidth * v.videoHeight;
      if (area > bestArea) {
        bestArea = area;
        bestEl = v;
      }
    }

    return bestEl;
  }

  getSurfaceDimensions(el: HTMLCanvasElement | HTMLVideoElement): { w: number; h: number } {
    if (el instanceof HTMLVideoElement) {
      return { w: el.videoWidth, h: el.videoHeight };
    }
    return { w: el.width, h: el.height };
  }

  sampleAnalysis(surface: HTMLCanvasElement | HTMLVideoElement): FrameAnalysis {
    this.analysisCtx.drawImage(surface, 0, 0, this.analysisW, this.analysisH);
    const img = this.analysisCtx.getImageData(0, 0, this.analysisW, this.analysisH);
    const rgba = new Uint8ClampedArray(img.data);
    const analysis = analyzeRgbaFrame(
      rgba,
      this.prevAnalysisRgba,
      this.analysisW,
      this.analysisH,
      this.roadModel,
    );
    this.prevAnalysisRgba = rgba;
    this.roadModel = analysis.updatedRoadModel;
    return analysis;
  }

  captureTile(
    surface: HTMLCanvasElement | HTMLVideoElement,
    tMs: number,
    axes: number[],
    buttons: number[],
    analysis: FrameAnalysis,
    tileW = 320,
    tileH = 240,
  ): FrameSample {
    const tile = document.createElement("canvas");
    tile.width = tileW;
    tile.height = tileH;
    const ctx = tile.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2D context for tile");
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
      roadConfidence: analysis.roadConfidence,
    };
  }
}

const BUTTON_TAGS: Array<[number, string, string]> = [
  [3, "GAS", "#22c55e"],
  [2, "BRK", "#ef4444"],
  [5, "DRIFT", "#f59e0b"],
  [4, "NITRO", "#38bdf8"],
  [1, "ITEM", "#a855f7"],
  [8, "RESCUE", "#ec4899"],
  [0, "A", "#94a3b8"],
  [9, "START", "#64748b"],
];

function drawTileAnnotations(
  ctx: CanvasRenderingContext2D,
  sample: FrameSample,
  x0: number,
  y0: number,
  w: number,
  h: number,
): void {
  // Timestamp + motion badge (top-left)
  const motionPct = (sample.motionScore * 100).toFixed(1);
  const lowMotion = sample.tMs > 180 && sample.motionScore < 0.01;
  ctx.fillStyle = lowMotion ? "rgba(185, 28, 28, 0.85)" : "rgba(15, 23, 42, 0.78)";
  ctx.fillRect(x0 + 6, y0 + 6, 118, 22);
  ctx.font = "bold 12px ui-monospace, Menlo, monospace";
  ctx.fillStyle = "#f8fafc";
  ctx.fillText(`+${Math.round(sample.tMs)}ms  Δ${motionPct}%`, x0 + 12, y0 + 21);

  // Predicted road target tick in mid-band (cyan diamond)
  if (sample.roadConfidence > 0.15) {
    const px = x0 + ((sample.roadOffsetX + 1) * 0.5) * w;
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

  // Stick vector widget (bottom-right)
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

  // Active button pills (top-right)
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

/**
 * Downsamples >8 frames evenly (always keeping first and last) and composites
 * an annotated 4x2 contact sheet + zoomed HUD/minimap crops on a canvas.
 */
export function buildContactSheetCanvas(
  samples: FrameSample[],
  finalSurface: HTMLCanvasElement | HTMLVideoElement | null,
  summary: {
    label: string;
    stopReason: string;
    durationMs: number;
    avgMotion: number;
    avgRoadConfidence: number;
  },
  crops: CropRegion[] = DEFAULT_STK_CROPS,
): HTMLCanvasElement {
  const maxTiles = 8;
  let chosen: FrameSample[] = [];
  if (samples.length <= maxTiles) {
    chosen = samples;
  } else {
    for (let i = 0; i < maxTiles; i++) {
      const idx = Math.round((i * (samples.length - 1)) / (maxTiles - 1));
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
  if (!ctx) throw new Error("Failed to get 2D context for contact sheet");

  // Background
  ctx.fillStyle = "#0b1120";
  ctx.fillRect(0, 0, totalW, totalH);

  // Header bar
  ctx.fillStyle = "#1e293b";
  ctx.fillRect(0, 0, totalW, headerH);
  ctx.fillStyle = "#f8fafc";
  ctx.font = "bold 15px ui-monospace, Menlo, monospace";
  const headerText = `${summary.label} | stop=${summary.stopReason} | ${Math.round(summary.durationMs)}ms | avgΔ=${(summary.avgMotion * 100).toFixed(1)}% | roadConf=${(summary.avgRoadConfidence * 100).toFixed(0)}%`;
  ctx.fillText(headerText, 12, 24);

  // Grid tiles
  for (let i = 0; i < chosen.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x0 = gap + col * (tileW + gap);
    const y0 = headerH + gap + row * (tileH + gap);
    ctx.drawImage(chosen[i].canvas, x0, y0, tileW, tileH);
    drawTileAnnotations(ctx, chosen[i], x0, y0, tileW, tileH);
  }

  // Bottom zoomed HUD / Minimap crop strip from the latest frame
  if (finalSurface && cropRowH > 0) {
    const srcW =
      finalSurface instanceof HTMLVideoElement
        ? finalSurface.videoWidth
        : finalSurface.width;
    const srcH =
      finalSurface instanceof HTMLVideoElement
        ? finalSurface.videoHeight
        : finalSurface.height;

    const stripY = headerH + rows * (tileH + gap) + gap;
    const cropSlotW = Math.floor((totalW - (crops.length + 1) * gap) / crops.length);
    const cropH = cropRowH - 12;

    for (let i = 0; i < crops.length; i++) {
      const c = crops[i];
      const dx = gap + i * (cropSlotW + gap);
      const sx = Math.max(0, Math.floor(c.x * srcW));
      const sy = Math.max(0, Math.floor(c.y * srcH));
      const sw = Math.max(1, Math.min(srcW - sx, Math.floor(c.w * srcW)));
      const sh = Math.max(1, Math.min(srcH - sy, Math.floor(c.h * srcH)));

      ctx.fillStyle = "#111827";
      ctx.fillRect(dx, stripY, cropSlotW, cropH);

      // Fit aspect ratio cleanly inside crop slot
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

const OVERLAY_ID = "__gameplay_sheet_overlay";

export function hideSheetOverlay(): void {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
}

export function showSheetOverlay(sheetCanvas: HTMLCanvasElement): void {
  if (typeof document === "undefined") return;
  hideSheetOverlay();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:2147483647;background:#0b1120;display:flex;align-items:center;justify-content:center;padding:8px;pointer-events:none;";

  sheetCanvas.style.cssText =
    "max-width:100%;max-height:100%;object-fit:contain;border:1px solid #334155;";

  overlay.appendChild(sheetCanvas);
  document.body.appendChild(overlay);
}
