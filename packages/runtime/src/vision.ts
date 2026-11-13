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
  { label: "MINIMAP", x: 0.0, y: 0.58, w: 0.23, h: 0.41 },
  { label: "TUTORIAL PROMPT", x: 0.12, y: 0.84, w: 0.76, h: 0.16 },
  { label: "LOOKAHEAD & ALERT", x: 0.22, y: 0.22, w: 0.56, h: 0.38 },
];

export function createInitialRoadModel(): RoadColorModel {
  return { r: 125, g: 118, b: 108, initialized: false };
}

/**
 * Penalizes pale yellow/cream desert sand (high luminance, strong yellow excess over blue,
 * and modest R-G gap) while leaving grey cobblestone, neutral asphalt, dark wood planks,
 * and rich reddish-brown dirt roads (where R-G >= 35 and lum < 135) untouched.
 */
function computeSandPenalty(r: number, g: number, b: number): number {
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

function isCandidateRoadSeedPixel(r: number, g: number, b: number): boolean {
  const lum = (r + g + b) / 3;
  if (lum < 28 || lum > 188) return false;
  const greenExcess = g - Math.max(r, b);
  if (greenExcess > 12) return false;
  if (b - r > 20 && lum > 110) return false;
  if (computeSandPenalty(r, g, b) > 0.15) return false;
  if (r - g > 68) return false;
  return true;
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

  // 2. Top-center banner delta & alert ratio (pure red banners + outlined red-orange "WRONG WAY!")
  let bannerChanged = 0;
  let bannerPixels = 0;
  let alertScore = 0;
  {
    const xStart = Math.floor(width * 0.15);
    const xEnd = Math.floor(width * 0.85);
    const yStart = Math.floor(height * 0.05);
    const yEnd = Math.floor(height * 0.35);
    const wwX0 = Math.floor(width * 0.28);
    const wwX1 = Math.floor(width * 0.72);
    const wwY0 = Math.floor(height * 0.22);

    const hasDarkOutlineNeighbor = (cx: number, cy: number): boolean => {
      const offsets: Array<[number, number]> = [
        [-2, 0],
        [2, 0],
        [0, -2],
        [0, 2],
        [-1, 0],
        [1, 0],
        [0, -1],
        [0, 1],
      ];
      for (const [dx, dy] of offsets) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const nIdx = (ny * width + nx) * 4;
        const nLum = (rgba[nIdx] + rgba[nIdx + 1] + rgba[nIdx + 2]) / 3;
        if (nLum < 55) return true;
      }
      return false;
    };

    for (let y = yStart; y < yEnd; y += 2) {
      for (let x = xStart; x < xEnd; x += 2) {
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        if (r > 175 && r - g > 65 && r - b > 65) {
          alertScore += 1;
        } else if (
          y >= wwY0 &&
          x >= wwX0 &&
          x <= wwX1 &&
          r >= 210 &&
          g >= 95 &&
          g <= 185 &&
          b <= 55 &&
          r - g >= 30 &&
          r - b >= 155 &&
          hasDarkOutlineNeighbor(x, y)
        ) {
          // Outlined orange-gold "WRONG WAY!" glyph strokes in SuperTuxKart
          alertScore += 2.5;
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
  const redAlertRatio = bannerPixels > 0 ? Math.min(1, alertScore / bannerPixels) : 0;

  // 3. Sample unoccluded ground patches flanking player kart wheels + nose lookahead
  // Avoids player sprite (x: 40%..60%, y: 52%..84%), minimap (x < 24%), and speedometer (x > 76%)
  let seedR = 0;
  let seedG = 0;
  let seedB = 0;
  let seedValid = 0;
  let seedTotal = 0;
  const samplePatch = (x0Frac: number, x1Frac: number, y0Frac: number, y1Frac: number) => {
    const xs = Math.floor(width * x0Frac);
    const xe = Math.floor(width * x1Frac);
    const ys = Math.floor(height * y0Frac);
    const ye = Math.floor(height * y1Frac);
    for (let y = ys; y < ye; y += 2) {
      for (let x = xs; x < xe; x += 2) {
        seedTotal++;
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];
        if (isCandidateRoadSeedPixel(r, g, b)) {
          seedR += r;
          seedG += g;
          seedB += b;
          seedValid++;
        }
      }
    }
  };
  samplePatch(0.28, 0.39, 0.64, 0.75);
  samplePatch(0.61, 0.72, 0.64, 0.75);
  samplePatch(0.44, 0.56, 0.47, 0.52);

  let evalModel: RoadColorModel = { ...roadModel };
  if (!evalModel.initialized && seedValid >= 8) {
    evalModel = {
      r: seedR / seedValid,
      g: seedG / seedValid,
      b: seedB / seedValid,
      initialized: true,
    };
  }

  // 4. Evaluate navigability across 24 columns in lookahead band (y: 45%..59%)
  // with vertical wall continuity check against above-horizon band (y: 20%..28%)
  const numCols = 24;
  const rawColScores = new Float64Array(numCols);
  const lookRows = [
    Math.floor(height * 0.45),
    Math.floor(height * 0.52),
    Math.floor(height * 0.59),
  ];
  const upperWallRows = [
    Math.floor(height * 0.2),
    Math.floor(height * 0.28),
  ];

  const refRG = evalModel.r - evalModel.g;
  const refGB = evalModel.g - evalModel.b;
  const refLum = (evalModel.r + evalModel.g + evalModel.b) / 3;

  const xMargin = Math.floor(width * 0.08);
  const spanW = width - 2 * xMargin;

  for (let c = 0; c < numCols; c++) {
    const x0 = xMargin + Math.floor((c / numCols) * spanW);
    const x1 = Math.max(x0 + 1, xMargin + Math.floor(((c + 1) / numCols) * spanW));
    let colScoreSum = 0;
    let colSamples = 0;

    let midR = 0;
    let midG = 0;
    let midB = 0;
    let midCount = 0;

    for (let rIdx = 0; rIdx < lookRows.length; rIdx++) {
      const y = lookRows[rIdx];
      for (let x = x0; x < x1; x++) {
        const idx = (y * width + x) * 4;
        const r = rgba[idx];
        const g = rgba[idx + 1];
        const b = rgba[idx + 2];

        if (rIdx < 2) {
          midR += r;
          midG += g;
          midB += b;
          midCount++;
        }

        const rg = r - g;
        const gb = g - b;
        const lum = (r + g + b) / 3;

        const chromaDiff = (Math.abs(rg - refRG) + Math.abs(gb - refGB)) / 510;
        const lumDiff = Math.abs(lum - refLum) / 255;
        const colorDist = chromaDiff * 0.68 + lumDiff * 0.32;

        const rightIdx = (y * width + Math.min(width - 1, x + 1)) * 4;
        const edge =
          (Math.abs(r - rgba[rightIdx]) +
            Math.abs(g - rgba[rightIdx + 1]) +
            Math.abs(b - rgba[rightIdx + 2])) /
          (3 * 255);

        const greenPenalty = Math.max(0, (g - Math.max(r, b) - 10) / 55);
        const skyPenalty = b - r > 22 && lum > 125 ? 0.85 : 0;
        const redWallPenalty = r - g > 65 ? 0.55 : 0;
        const sandPenalty = computeSandPenalty(r, g, b);
        const glareWallPenalty = lum > 192 ? Math.min(0.75, (lum - 192) / 35) : 0;

        const pixelScore = Math.max(
          0,
          1 -
            (colorDist * 2.05 +
              edge * 0.85 +
              greenPenalty +
              skyPenalty +
              redWallPenalty +
              sandPenalty +
              glareWallPenalty),
        );
        colScoreSum += pixelScore;
        colSamples++;
      }
    }

    // Vertical wall continuity penalty: a close wall extends continuously above the horizon
    // (y: 20%..28%) with nearly identical color to the lookahead band, unlike open sky,
    // green hills, or dark wooden tunnel roofs (upperLum < 76).
    let wallPenalty = 0;
    if (midCount > 0) {
      let upR = 0;
      let upG = 0;
      let upB = 0;
      let upCount = 0;
      for (const uy of upperWallRows) {
        for (let x = x0; x < x1; x++) {
          const idx = (uy * width + x) * 4;
          upR += rgba[idx];
          upG += rgba[idx + 1];
          upB += rgba[idx + 2];
          upCount++;
        }
      }
      if (upCount > 0) {
        upR /= upCount;
        upG /= upCount;
        upB /= upCount;
        const mR = midR / midCount;
        const mG = midG / midCount;
        const mB = midB / midCount;
        const upLum = (upR + upG + upB) / 3;
        const upIsSky = upB - upR > 18 && upLum > 105;
        const upIsFoliage = upG - Math.max(upR, upB) > 12;
        const upIsDarkCeiling = upLum < 76;
        if (!upIsSky && !upIsFoliage && !upIsDarkCeiling) {
          const verticalRgbDiff =
            (Math.abs(upR - mR) + Math.abs(upG - mG) + Math.abs(upB - mB)) / 3;
          if (verticalRgbDiff < 26) {
            wallPenalty = 0.82 * Math.min(1, (26 - verticalRgbDiff) / 14);
          }
        }
      }
    }

    const baseColScore = colSamples > 0 ? colScoreSum / colSamples : 0;
    rawColScores[c] = Math.max(0, baseColScore - wallPenalty);
  }

  // Smooth column scores [0.25, 0.5, 0.25]
  const colScores = new Float64Array(numCols);
  for (let c = 0; c < numCols; c++) {
    const left = c > 0 ? rawColScores[c - 1] : rawColScores[c];
    const right = c < numCols - 1 ? rawColScores[c + 1] : rawColScores[c];
    colScores[c] = 0.25 * left + 0.5 * rawColScores[c] + 0.25 * right;
  }

  // Thresholded centroid: off-road columns below navThreshold=0.45 contribute zero weight
  // so desert sand or walls never dilute sharp steering offsets toward 0.
  const navThreshold = 0.45;
  let weightSum = 0;
  let weightedPos = 0;
  let activeCols = 0;
  let activeExcessSum = 0;
  let maxColScore = 0;

  for (let c = 0; c < numCols; c++) {
    const s = colScores[c];
    if (s > maxColScore) maxColScore = s;
    const excess = Math.max(0, s - navThreshold);
    if (excess > 0) {
      activeCols++;
      activeExcessSum += excess / (1 - navThreshold);
      const normX = ((c + 0.5) / numCols) * 2 - 1; // [-1 .. +1]
      const w = excess * excess;
      weightSum += w;
      weightedPos += w * normX;
    }
  }

  const roadOffsetX = weightSum > 1e-4 ? weightedPos / weightSum : 0;
  const widthSupport = Math.min(1, activeCols / 6);
  const meanActiveStrength = activeCols > 0 ? activeExcessSum / activeCols : 0;
  const roadConfidence =
    activeCols === 0
      ? maxColScore * 0.25
      : Math.min(1, widthSupport * (0.35 + 0.65 * meanActiveStrength));

  // 5. Anti-self-poisoning road model update:
  // Only adapt EMA when genuinely on a high-confidence road corridor and reasonably centered.
  let nextModel = { ...evalModel };
  const seedValidRatio = seedTotal > 0 ? seedValid / seedTotal : 0;
  if (
    seedValid >= 10 &&
    seedValidRatio >= 0.4 &&
    roadConfidence >= 0.52 &&
    Math.abs(roadOffsetX) <= 0.36
  ) {
    const avgR = seedR / seedValid;
    const avgG = seedG / seedValid;
    const avgB = seedB / seedValid;
    if (!roadModel.initialized) {
      nextModel = { r: avgR, g: avgG, b: avgB, initialized: true };
    } else {
      const alpha = 0.08;
      nextModel = {
        r: roadModel.r * (1 - alpha) + avgR * alpha,
        g: roadModel.g * (1 - alpha) + avgG * alpha,
        b: roadModel.b * (1 - alpha) + avgB * alpha,
        initialized: true,
      };
    }
  } else if (!roadModel.initialized && roadConfidence < 0.52) {
    nextModel = { ...roadModel };
  }

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

  sampleAnalysis(
    surface: HTMLCanvasElement | HTMLVideoElement,
    mutateModel = true,
  ): FrameAnalysis {
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
    if (mutateModel) {
      this.prevAnalysisRgba = rgba;
      this.roadModel = analysis.updatedRoadModel;
    }
    return analysis;
  }

  captureFullFrame(surface: HTMLCanvasElement | HTMLVideoElement): HTMLCanvasElement | null {
    const { w, h } = this.getSurfaceDimensions(surface);
    if (w <= 0 || h <= 0) return null;
    const snap = document.createElement("canvas");
    snap.width = w;
    snap.height = h;
    const ctx = snap.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(surface, 0, 0, w, h);
    return snap;
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
