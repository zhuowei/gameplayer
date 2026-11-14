#!/usr/bin/env bun
import sharp from "sharp";
import cvModule from "@techstark/opencv-js";
import { env, pipeline, RawImage } from "@huggingface/transformers";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "../..");

process.on("exit", () => {
  try {
    fs.unlinkSync(path.resolve(process.cwd(), ":memory:.ses"));
  } catch {
    // ignore if absent
  }
});

env.cacheDir = path.resolve(WORKSPACE_ROOT, ".cache/models");
env.allowLocalModels = true;
// Default to offline so perception works inside network-isolated sandboxes without BypassSandbox
env.allowRemoteModels = process.env.ALLOW_REMOTE_MODELS === "1";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let cvInstancePromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getOpenCv(): Promise<any> {
  if (!cvInstancePromise) {
    cvInstancePromise = (async () => {
      const mod = cvModule instanceof Promise ? await cvModule : cvModule;
      if (mod && mod.Mat) return mod;
      return await new Promise((resolve) => {
        mod.onRuntimeInitialized = () => resolve(mod);
      });
    })();
  }
  return cvInstancePromise;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let depthPipelinePromise: Promise<any> | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getDepthEstimator(): Promise<any> {
  if (!depthPipelinePromise) {
    depthPipelinePromise = pipeline(
      "depth-estimation",
      "onnx-community/depth-anything-v2-small",
      { dtype: "q8" },
    );
  }
  return depthPipelinePromise;
}

export interface SheetLayout {
  isContactSheet: boolean;
  sheetLeft: number;
  sheetTop: number;
  sheetWidth: number;
  sheetHeight: number;
  tile1Box: { left: number; top: number; width: number; height: number } | null;
  activeViewBox: { left: number; top: number; width: number; height: number };
  minimapBox: { left: number; top: number; width: number; height: number };
}

/**
 * Detects whether an image is an annotated Runtime Contact Sheet (letterboxed on #0b1120)
 * or a raw game viewport screenshot, and returns exact extraction boxes.
 */
export function detectScreenshotLayout(
  rgb: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  channels = 3,
): SheetLayout {
  // Check if top/bottom borders match contact-sheet #0b1120 (11, 17, 32) letterbox or #1e293b header
  let bgMatches = 0;
  let bgTotal = 0;
  for (let x = 8; x < width - 8; x += Math.max(8, Math.floor(width / 32))) {
    for (const y of [4, height - 5]) {
      if (y < 0 || y >= height) continue;
      const idx = (y * width + x) * channels;
      const d =
        Math.abs(rgb[idx] - 11) +
        Math.abs(rgb[idx + 1] - 17) +
        Math.abs(rgb[idx + 2] - 32);
      if (d <= 24) bgMatches++;
      bgTotal++;
    }
  }

  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const idx = (y * width + x) * channels;
      const diff =
        Math.abs(rgb[idx] - 11) +
        Math.abs(rgb[idx + 1] - 17) +
        Math.abs(rgb[idx + 2] - 32);
      if (diff > 28) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const sheetW = Math.max(1, maxX - minX + 1);
  const sheetH = Math.max(1, maxY - minY + 1);
  const aspect = sheetW / sheetH;

  // Canonical 4x2 contact sheet with crop row is 1310 x 722 (aspect ~1.814)
  // Canonical 4x1 contact sheet with crop row is 1310 x 476 (aspect ~2.752)
  const looksLikeSheet =
    bgTotal > 0 &&
    bgMatches / bgTotal >= 0.7 &&
    sheetW >= width * 0.65 &&
    ((aspect >= 1.68 && aspect <= 1.96) || (aspect >= 2.55 && aspect <= 2.95));

  if (looksLikeSheet) {
    const rows = aspect > 2.3 ? 1 : 2;
    const canonicalW = 1310;
    const canonicalH = 38 + rows * 240 + (rows + 1) * 6 + 186;
    const sx = sheetW / canonicalW;
    const sy = sheetH / canonicalH;

    const clampBox = (cx: number, cy: number, cw: number, ch: number) => {
      const left = Math.max(0, Math.min(width - 2, Math.round(minX + cx * sx)));
      const top = Math.max(0, Math.min(height - 2, Math.round(minY + cy * sy)));
      const w = Math.max(2, Math.min(width - left, Math.round(cw * sx)));
      const h = Math.max(2, Math.min(height - top, Math.round(ch * sy)));
      return { left, top, width: w, height: h };
    };

    const tile1Box = clampBox(6, 44, 320, 240);
    // Last tile in grid (col 3, row = rows - 1)
    const lastRowY = 38 + 6 + (rows - 1) * (240 + 6);
    const activeViewBox = clampBox(6 + 3 * (320 + 6), lastRowY, 320, 240);

    // First slot in bottom crop strip is FINAL MINIMAP
    const stripY = 38 + rows * (240 + 6) + 6;
    const cropSlotW = Math.floor((1310 - 4 * 6) / 3); // 428
    const cropH = 174;
    const minimapBox = clampBox(6, stripY, cropSlotW, cropH);

    return {
      isContactSheet: true,
      sheetLeft: minX,
      sheetTop: minY,
      sheetWidth: sheetW,
      sheetHeight: sheetH,
      tile1Box,
      activeViewBox,
      minimapBox,
    };
  }

  // Raw viewport screenshot: locate active non-black game area if letterboxed
  return {
    isContactSheet: false,
    sheetLeft: 0,
    sheetTop: 0,
    sheetWidth: width,
    sheetHeight: height,
    tile1Box: null,
    activeViewBox: { left: 0, top: 0, width, height },
    minimapBox: {
      left: 0,
      top: Math.floor(height * 0.58),
      width: Math.max(2, Math.floor(width * 0.23)),
      height: Math.max(2, Math.floor(height * 0.41)),
    },
  };
}

export interface Depth3DAnalysis {
  corridorOffsetX: number;
  centerClearance: number;
  maxClearance: number;
  wallOrObstacleAhead: boolean;
  sectorClearanceLtoR: number[];
  rawDisparityGrid?: { width: number; height: number; data: Float32Array };
}

/**
 * Analyzes Depth Anything V2 inverse-depth (disparity) map where:
 * - Lower values = farther away (deep open corridor / horizon)
 * - Higher values = closer to camera (near ground, walls, posts, obstacles)
 */
export function analyzeDisparityMap(
  disparity: Float32Array,
  dw: number,
  dh: number,
): Depth3DAnalysis {
  const numSectors = 7;
  const rawSectorDisp = new Float64Array(numSectors);

  // Sample horizon-to-midground band (y: 0.28..0.46) strictly above player kart head (y >= 0.48)
  // and exclude top badge overlays (y < 0.14).
  const y0 = Math.max(0, Math.floor(dh * 0.28));
  const y1 = Math.max(y0 + 1, Math.floor(dh * 0.46));
  const xMargin = Math.floor(dw * 0.05);
  const spanW = dw - 2 * xMargin;

  for (let s = 0; s < numSectors; s++) {
    const sx0 = xMargin + Math.floor((s / numSectors) * spanW);
    const sx1 = Math.max(sx0 + 1, xMargin + Math.floor(((s + 1) / numSectors) * spanW));
    const vals: number[] = [];
    for (let y = y0; y < y1; y++) {
      for (let x = sx0; x < sx1; x++) {
        vals.push(disparity[y * dw + x]);
      }
    }
    vals.sort((a, b) => a - b);
    // Use 88th percentile disparity in each sector so thin vertical posts/trees (~15-20% of sector width) register clearly
    const p88 = vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.88))] ?? 0;
    rawSectorDisp[s] = p88;
  }

  // Reference near-ground disparity (flanking player wheels at y: 0.72..0.84, x: 0.25..0.38 & 0.62..0.75)
  let nearSum = 0;
  let nearCnt = 0;
  for (let y = Math.floor(dh * 0.72); y < Math.floor(dh * 0.84); y++) {
    for (let x = Math.floor(dw * 0.25); x < Math.floor(dw * 0.75); x++) {
      const xf = x / dw;
      if (xf > 0.38 && xf < 0.62) continue;
      nearSum += disparity[y * dw + x];
      nearCnt++;
    }
  }
  const nearGroundDisp = nearCnt > 0 ? nearSum / nearCnt : 4.5;

  // Sky / far reference (15th percentile across upper horizon y: 0.16..0.32)
  const skyVals: number[] = [];
  for (let y = Math.floor(dh * 0.16); y < Math.floor(dh * 0.32); y += 2) {
    for (let x = xMargin; x < dw - xMargin; x += 2) {
      skyVals.push(disparity[y * dw + x]);
    }
  }
  skyVals.sort((a, b) => a - b);
  const farRefDisp = skyVals[Math.floor(skyVals.length * 0.15)] ?? 0.2;
  const dispRange = Math.max(0.8, nearGroundDisp - farRefDisp);

  // Convert sector disparity -> normalized 3D clearance in [0..1] (1 = deep open corridor, 0 = right in face)
  const sectorClearanceLtoR: number[] = [];
  for (let s = 0; s < numSectors; s++) {
    const normDisp = (rawSectorDisp[s] - farRefDisp) / dispRange;
    const clearance = Math.max(0, Math.min(1, 1 - normDisp * 1.45));
    sectorClearanceLtoR.push(Number(clearance.toFixed(3)));
  }

  const maxClearance = Math.max(...sectorClearanceLtoR);
  const centerClearance = sectorClearanceLtoR[3];

  // Mode-seeking contiguous corridor selection:
  // Avoids averaging left (-0.8) and right (+0.8) to 0.0 when a post/pillar blocks dead-center!
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
      const normX = ((runEnd + 0.5) / numSectors) * 2 - 1;
      const w = excess * excess;
      wSum += w;
      wxSum += w * normX;
      // Gentle forward preference (1 - 0.12 * |x|) only breaks ties between equally wide/deep corridors
      runScore += cVal * cVal * (1 - 0.12 * Math.abs(normX));
      runEnd++;
    }
    if (runScore > bestRunScore && wSum > 1e-6) {
      bestRunScore = runScore;
      bestCorridorX = wxSum / wSum;
    }
    sIdx = runEnd;
  }

  const corridorOffsetX = Number(bestCorridorX.toFixed(3));

  const wallOrObstacleAhead =
    maxClearance < 0.45 ||
    (centerClearance < maxClearance - 0.12 && Math.abs(corridorOffsetX) >= 0.22);

  return {
    corridorOffsetX,
    centerClearance,
    maxClearance: Number(maxClearance.toFixed(3)),
    wallOrObstacleAhead,
    sectorClearanceLtoR,
  };
}

export interface OpenCvSceneAnalysis {
  vanishingPointX: number | null;
  roadEdgeLines: number;
  minimap: {
    playerFound: boolean;
    playerPosNorm: [number, number] | null;
    headingDeg: number | null;
    onRibbon: boolean;
    ribbonPixels: number;
    turnAhead: "straight" | "left" | "right" | "hairpin_left" | "hairpin_right" | "unknown";
    turnAheadDeg: number | null;
  };
}

/**
 * Uses @techstark/opencv-js for:
 * 1) Canny + Probabilistic Hough Transform road-boundary vanishing point in 3D view
 * 2) Minimap track ribbon segmentation + player marker pose & ego-centric curvature ahead
 */
export async function analyzeOpenCvGeometry(
  viewRgb: Uint8Array,
  viewW: number,
  viewH: number,
  minimapRgb: Uint8Array,
  mmW: number,
  mmH: number,
  tile1Rgb?: Uint8Array | null,
  t1W = 0,
  t1H = 0,
): Promise<OpenCvSceneAnalysis> {
  const cv = await getOpenCv();

  // --- Part A: 3D View Canny + HoughLinesP Vanishing Point ---
  const rgba = new Uint8Array(viewW * viewH * 4);
  for (let i = 0, j = 0; i < viewRgb.length; i += 3, j += 4) {
    rgba[j] = viewRgb[i];
    rgba[j + 1] = viewRgb[i + 1];
    rgba[j + 2] = viewRgb[i + 2];
    rgba[j + 3] = 255;
  }

  const src = cv.matFromArray(viewH, viewW, cv.CV_8UC4, rgba);
  const gray = new cv.Mat();
  const blurred = new cv.Mat();
  const edges = new cv.Mat();
  const lines = new cv.Mat();

  let vanishingPointX: number | null = null;
  let roadEdgeLines = 0;

  try {
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 1.2);
    cv.Canny(blurred, edges, 32, 100);

    // Mask out top UI badges (y < 0.24), player sprite (center bottom), and bottom HUD (y > 0.80)
    cv.HoughLinesP(edges, lines, 1, Math.PI / 180, 20, 18, 10);

    interface SegLine {
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      slope: number;
      len: number;
    }
    const validLines: SegLine[] = [];
    const horizonY = viewH * 0.36;
    const vpCandidates: Array<{ x: number; w: number }> = [];

    const numHoughLines = Math.floor(lines.data32S.length / 4);
    for (let i = 0; i < numHoughLines; i++) {
      const x1 = lines.data32S[i * 4];
      const y1 = lines.data32S[i * 4 + 1];
      const x2 = lines.data32S[i * 4 + 2];
      const y2 = lines.data32S[i * 4 + 3];

      const midY = (y1 + y2) * 0.5;
      const midX = (x1 + x2) * 0.5;
      if (midY < viewH * 0.26 || midY > viewH * 0.78) continue;
      // Exclude minimap bottom-left & speedometer bottom-right
      if (midY > viewH * 0.58 && (midX < viewW * 0.25 || midX > viewW * 0.75)) continue;
      // Exclude player kart box
      if (midY > viewH * 0.52 && midX > viewW * 0.38 && midX < viewW * 0.62) continue;

      const dx = x2 - x1;
      const dy = y2 - y1;
      const len = Math.hypot(dx, dy);
      if (Math.abs(dx) < 4) continue;
      const slope = dy / dx;
      // Keep longitudinal perspective lines (13.5 deg .. 78 deg) and reject cross-track horizontal lines
      if (Math.abs(slope) < 0.24 || Math.abs(slope) > 4.5) continue;

      validLines.push({ x1, y1, x2, y2, slope, len });
      // Project line to horizonY = 0.36 * viewH
      const xAtHorizon = x1 + (horizonY - y1) / slope;
      if (xAtHorizon >= -viewW * 0.3 && xAtHorizon <= viewW * 1.3) {
        vpCandidates.push({ x: xAtHorizon, w: len });
      }
    }

    roadEdgeLines = validLines.length;
    if (vpCandidates.length >= 2) {
      vpCandidates.sort((a, b) => a.x - b.x);
      let totalW = 0;
      for (const c of vpCandidates) totalW += c.w;
      let accW = 0;
      let medX = vpCandidates[0].x;
      for (const c of vpCandidates) {
        accW += c.w;
        if (accW >= totalW * 0.5) {
          medX = c.x;
          break;
        }
      }
      const normVp = Math.max(-1, Math.min(1, (medX / viewW) * 2 - 1));
      vanishingPointX = Number(normVp.toFixed(3));
    }
  } finally {
    src.delete();
    gray.delete();
    blurred.delete();
    edges.delete();
    lines.delete();
  }

  // --- Part B: Minimap Ribbon & Player Marker Pose ---
  // Trim dark #111827 letterbox padding inside FINAL MINIMAP slot & top "FINAL MINIMAP" pill
  let activeX0 = mmW;
  let activeX1 = 0;
  let activeY0 = mmH;
  let activeY1 = 0;
  for (let y = 24; y < mmH - 2; y++) {
    for (let x = 2; x < mmW - 2; x++) {
      const idx = (y * mmW + x) * 3;
      const d =
        Math.abs(minimapRgb[idx] - 17) +
        Math.abs(minimapRgb[idx + 1] - 24) +
        Math.abs(minimapRgb[idx + 2] - 39);
      if (d > 28) {
        if (x < activeX0) activeX0 = x;
        if (x > activeX1) activeX1 = x;
        if (y < activeY0) activeY0 = y;
        if (y > activeY1) activeY1 = y;
      }
    }
  }
  // Allow full-height scan once X bounds of map inside slot are known
  if (activeX1 > activeX0 + 20) {
    activeY0 = 2;
    activeY1 = mmH - 2;
  } else {
    activeX0 = 0;
    activeX1 = mmW - 1;
    activeY0 = 0;
    activeY1 = mmH - 1;
  }

  const mapW = Math.max(10, activeX1 - activeX0 + 1);
  const mapH = Math.max(10, activeY1 - activeY0 + 1);

  const findRedMarker = (
    buf: Uint8Array,
    bw: number,
    x0: number,
    y0: number,
    w: number,
    h: number,
    skipTopPill = false,
  ): [number, number] | null => {
    let sx = 0;
    let sy = 0;
    let sw = 0;
    for (let y = y0; y < y0 + h; y++) {
      for (let x = x0; x < x0 + w; x++) {
        if (skipTopPill && y - y0 < 22 && x - x0 < 120) continue;
        const idx = (y * bw + x) * 3;
        const r = buf[idx];
        const g = buf[idx + 1];
        const b = buf[idx + 2];
        // Bright red/crimson ring or marker in STK minimap (high R, low G/B)
        if (r >= 175 && r - g >= 85 && r - b >= 85) {
          // Check if adjacent to dark icon outline so red start-line tick doesn't dominate
          let hasDark = false;
          for (const [dx, dy] of [
            [-2, 0],
            [2, 0],
            [0, -2],
            [0, 2],
            [3, 0],
            [-3, 0],
          ]) {
            const nx = Math.max(x0, Math.min(x0 + w - 1, x + dx));
            const ny = Math.max(y0, Math.min(y0 + h - 1, y + dy));
            const nIdx = (ny * bw + nx) * 3;
            if (buf[nIdx] + buf[nIdx + 1] + buf[nIdx + 2] < 135) {
              hasDark = true;
              break;
            }
          }
          const weight = hasDark ? 4.0 : 0.4;
          sx += (x - x0) * weight;
          sy += (y - y0) * weight;
          sw += weight;
        }
      }
    }
    if (sw < 6) return null;
    return [sx / sw / w, sy / sw / h];
  };

  const playerPosNorm = findRedMarker(minimapRgb, mmW, activeX0, activeY0, mapW, mapH, true);

  // Estimate heading from Tile 1 minimap -> Final minimap displacement when available
  let headingDeg: number | null = null;
  if (playerPosNorm && tile1Rgb && t1W > 0 && t1H > 0) {
    const t1MmX0 = 0;
    const t1MmY0 = Math.floor(t1H * 0.58);
    const t1MmW = Math.floor(t1W * 0.23);
    const t1MmH = Math.floor(t1H * 0.41);
    const p1 = findRedMarker(tile1Rgb, t1W, t1MmX0, t1MmY0, t1MmW, t1MmH, false);
    if (p1) {
      const dx = playerPosNorm[0] - p1[0];
      const dy = playerPosNorm[1] - p1[1];
      if (Math.hypot(dx, dy) >= 0.009) {
        headingDeg = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
      }
    }
  }

  // Segment bright minimap track ribbon via OpenCV local positive contrast (Difference-of-Gaussians)
  // Works across yellow sand, green forest, grey stone, or dark backgrounds without eroding thin 2px lines!
  const mmGray = new cv.Mat(mapH, mapW, cv.CV_8UC1);
  const mmBg = new cv.Mat();
  const mmDiff = new cv.Mat();
  let ribbonPixels = 0;
  const ribbonPts: Array<[number, number]> = [];

  try {
    for (let y = 0; y < mapH; y++) {
      for (let x = 0; x < mapW; x++) {
        const sx = activeX0 + x;
        const sy = activeY0 + y;
        const idx = (sy * mmW + sx) * 3;
        const lum = Math.round(
          0.299 * minimapRgb[idx] +
            0.587 * minimapRgb[idx + 1] +
            0.114 * minimapRgb[idx + 2],
        );
        mmGray.ucharPtr(y, x)[0] = lum;
      }
    }

    cv.GaussianBlur(mmGray, mmBg, new cv.Size(17, 17), 4.5);
    cv.subtract(mmGray, mmBg, mmDiff);

    for (let y = 2; y < mapH - 2; y++) {
      for (let x = 2; x < mapW - 2; x++) {
        const sx = activeX0 + x;
        const sy = activeY0 + y;
        if (sy < 24 && sx < 130) continue;
        // Skip player icon immediate core so red/white kart badge isn't counted as ribbon
        if (
          playerPosNorm &&
          Math.hypot(x / mapW - playerPosNorm[0], y / mapH - playerPosNorm[1]) < 0.045
        ) {
          continue;
        }
        const gVal = mmGray.ucharPtr(y, x)[0];
        const dVal = mmDiff.ucharPtr(y, x)[0];
        if (gVal >= 182 && dVal >= 10) {
          ribbonPixels++;
          ribbonPts.push([x / mapW, y / mapH]);
        }
      }
    }
  } finally {
    mmGray.delete();
    mmBg.delete();
    mmDiff.delete();
  }

  let onRibbon = false;
  let turnAhead: OpenCvSceneAnalysis["minimap"]["turnAhead"] = "unknown";
  let turnAheadDeg: number | null = null;

  if (playerPosNorm && ribbonPts.length >= 20) {
    let minDist = Infinity;
    for (const [rx, ry] of ribbonPts) {
      const d = Math.hypot(rx - playerPosNorm[0], ry - playerPosNorm[1]);
      if (d < minDist) minDist = d;
    }
    onRibbon = minDist <= 0.085;

    if (headingDeg !== null) {
      const hRad = (headingDeg * Math.PI) / 180;
      const hx = Math.cos(hRad);
      const hy = Math.sin(hRad);
      // Right-hand perpendicular vector in screen coords (x right, y down): (-hy, hx)
      const rxVec = -hy;
      const ryVec = hx;

      // Sample ribbon points ahead of player in forward cone (dist 0.10..0.28, forward dot > 0.04)
      let latSum = 0;
      let fwdSum = 0;
      let aheadCnt = 0;
      for (const [px, py] of ribbonPts) {
        const vx = px - playerPosNorm[0];
        const vy = py - playerPosNorm[1];
        const dist = Math.hypot(vx, vy);
        if (dist < 0.09 || dist > 0.28) continue;
        const fwd = vx * hx + vy * hy;
        const lat = vx * rxVec + vy * ryVec;
        if (fwd > 0.03 && Math.abs(lat) < dist * 0.92) {
          latSum += lat;
          fwdSum += fwd;
          aheadCnt++;
        }
      }

      if (aheadCnt >= 5) {
        const meanLat = latSum / aheadCnt;
        const meanFwd = Math.max(0.04, fwdSum / aheadCnt);
        const deg = Math.round((Math.atan2(meanLat, meanFwd) * 180) / Math.PI);
        turnAheadDeg = deg;
        if (deg >= 42) turnAhead = "hairpin_right";
        else if (deg >= 15) turnAhead = "right";
        else if (deg <= -42) turnAhead = "hairpin_left";
        else if (deg <= -15) turnAhead = "left";
        else turnAhead = "straight";
      }
    }
  }

  return {
    vanishingPointX,
    roadEdgeLines,
    minimap: {
      playerFound: playerPosNorm !== null,
      playerPosNorm: playerPosNorm
        ? [Number(playerPosNorm[0].toFixed(3)), Number(playerPosNorm[1].toFixed(3))]
        : null,
      headingDeg,
      onRibbon,
      ribbonPixels,
      turnAhead,
      turnAheadDeg,
    },
  };
}

export interface PerceptionReport {
  mode: "contact_sheet" | "raw_viewport";
  imageSize: [number, number];
  latencyMs: number;
  depth3d: Omit<Depth3DAnalysis, "rawDisparityGrid">;
  opencv: OpenCvSceneAnalysis;
  recommendation: {
    action:
      | "driveServo"
      | "driveServo_biased"
      | "runChunk_turn_left"
      | "runChunk_turn_right"
      | "reverse_and_realign";
    suggestedSteerBias: number;
    suggestedMaxDurationMs: number;
    reason: string;
  };
  debugImagePath?: string;
}

export async function perceiveScreenshot(
  imagePath: string,
  debugOutPath?: string,
): Promise<PerceptionReport> {
  const t0 = performance.now();
  const { data: fullRgb, info } = await sharp(imagePath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const layout = detectScreenshotLayout(fullRgb, info.width, info.height, 3);

  const viewW = 320;
  const viewH = 240;
  const viewBuf = await sharp(imagePath)
    .extract(layout.activeViewBox)
    .resize(viewW, viewH)
    .removeAlpha()
    .raw()
    .toBuffer();

  const mmBufObj = await sharp(imagePath)
    .extract(layout.minimapBox)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let tile1Buf: Buffer | null = null;
  if (layout.tile1Box) {
    tile1Buf = await sharp(imagePath)
      .extract(layout.tile1Box)
      .resize(viewW, viewH)
      .removeAlpha()
      .raw()
      .toBuffer();
  }

  const [depthEstimator, cvAnalysis] = await Promise.all([
    getDepthEstimator(),
    analyzeOpenCvGeometry(
      new Uint8Array(viewBuf),
      viewW,
      viewH,
      new Uint8Array(mmBufObj.data),
      mmBufObj.info.width,
      mmBufObj.info.height,
      tile1Buf ? new Uint8Array(tile1Buf) : null,
      viewW,
      viewH,
    ),
  ]);

  const rawImg = new RawImage(new Uint8ClampedArray(viewBuf), viewW, viewH, 3);
  const depthOut = await depthEstimator(rawImg);
  const pd = depthOut.predicted_depth;
  const dispData = pd.data as Float32Array;
  const [dh, dw] = pd.dims as [number, number];

  const depth3d = analyzeDisparityMap(dispData, dw, dh);

  // Fuse Depth Anything V2 3D free-space + OpenCV vanishing point + Minimap curvature
  let fusedOffset = depth3d.corridorOffsetX;
  const reasons: string[] = [];

  if (cvAnalysis.vanishingPointX !== null && cvAnalysis.roadEdgeLines >= 3) {
    fusedOffset = 0.7 * fusedOffset + 0.3 * cvAnalysis.vanishingPointX;
  }

  if (cvAnalysis.minimap.turnAheadDeg !== null) {
    const mmSteer = Math.max(-0.85, Math.min(0.85, cvAnalysis.minimap.turnAheadDeg / 65));
    fusedOffset = 0.6 * fusedOffset + 0.4 * mmSteer;
    if (Math.abs(cvAnalysis.minimap.turnAheadDeg) >= 18) {
      reasons.push(
        `minimap ribbon curves ${cvAnalysis.minimap.turnAhead} (${cvAnalysis.minimap.turnAheadDeg > 0 ? "+" : ""}${cvAnalysis.minimap.turnAheadDeg} deg)`,
      );
    }
  }

  const suggestedSteerBias = Number(
    Math.max(-0.65, Math.min(0.65, fusedOffset * 0.85)).toFixed(2),
  );

  let action: PerceptionReport["recommendation"]["action"] = "driveServo";
  let suggestedMaxDurationMs = 2400;

  if (depth3d.maxClearance < 0.24 && depth3d.centerClearance < 0.2) {
    action = "reverse_and_realign";
    suggestedMaxDurationMs = 900;
    reasons.unshift(
      `3D depth blocked across horizon (maxClearance=${depth3d.maxClearance.toFixed(2)})`,
    );
  } else if (
    (depth3d.wallOrObstacleAhead && Math.abs(fusedOffset) >= 0.22) ||
    Math.abs(cvAnalysis.minimap.turnAheadDeg ?? 0) >= 42
  ) {
    action = fusedOffset >= 0 ? "runChunk_turn_right" : "runChunk_turn_left";
    suggestedMaxDurationMs = 1350;
    reasons.unshift(
      `3D open corridor at x=${depth3d.corridorOffsetX >= 0 ? "+" : ""}${depth3d.corridorOffsetX.toFixed(2)} (centerClearance=${depth3d.centerClearance.toFixed(2)})`,
    );
  } else if (Math.abs(suggestedSteerBias) >= 0.16) {
    action = "driveServo_biased";
    suggestedMaxDurationMs = 1800;
    reasons.unshift(
      `3D corridor gently offset (${depth3d.corridorOffsetX >= 0 ? "+" : ""}${depth3d.corridorOffsetX.toFixed(2)})`,
    );
  } else {
    reasons.unshift(
      `clear 3D corridor ahead (centerClearance=${depth3d.centerClearance.toFixed(2)})`,
    );
  }

  if (debugOutPath) {
    // Render side-by-side active view + turbo-style depth map (640 x 240)
    const heatRgb = new Uint8Array(viewW * viewH * 3);
    let minD = Infinity;
    let maxD = -Infinity;
    for (let i = 0; i < dispData.length; i++) {
      if (dispData[i] < minD) minD = dispData[i];
      if (dispData[i] > maxD) maxD = dispData[i];
    }
    const spanD = Math.max(1e-4, maxD - minD);
    for (let y = 0; y < viewH; y++) {
      const dy = Math.min(dh - 1, Math.floor((y / viewH) * dh));
      for (let x = 0; x < viewW; x++) {
        const dx = Math.min(dw - 1, Math.floor((x / viewW) * dw));
        // normClose: 1 = close (warm red/yellow), 0 = far open corridor (cool cyan/blue)
        const normClose = (dispData[dy * dw + dx] - minD) / spanD;
        const outIdx = (y * viewW + x) * 3;
        heatRgb[outIdx] = Math.round(255 * Math.min(1, normClose * 1.5));
        heatRgb[outIdx + 1] = Math.round(255 * Math.sin(normClose * Math.PI));
        heatRgb[outIdx + 2] = Math.round(255 * Math.max(0, 1 - normClose * 1.4));
      }
    }

    const leftPng = await sharp(viewBuf, {
      raw: { width: viewW, height: viewH, channels: 3 },
    })
      .png()
      .toBuffer();
    const rightPng = await sharp(heatRgb, {
      raw: { width: viewW, height: viewH, channels: 3 },
    })
      .png()
      .toBuffer();

    await sharp({
      create: {
        width: viewW * 2,
        height: viewH,
        channels: 3,
        background: { r: 11, g: 17, b: 32 },
      },
    })
      .composite([
        { input: leftPng, left: 0, top: 0 },
        { input: rightPng, left: viewW, top: 0 },
      ])
      .jpeg({ quality: 85 })
      .toFile(debugOutPath);
  }

  return {
    mode: layout.isContactSheet ? "contact_sheet" : "raw_viewport",
    imageSize: [info.width, info.height],
    latencyMs: Math.round(performance.now() - t0),
    depth3d,
    opencv: cvAnalysis,
    recommendation: {
      action,
      suggestedSteerBias,
      suggestedMaxDurationMs,
      reason: reasons.join("; "),
    },
    ...(debugOutPath ? { debugImagePath: debugOutPath } : {}),
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: bun run perceive <screenshot.jpg> [--out <debug-depth.jpg>]",
    );
    process.exit(args.length === 0 ? 1 : 0);
  }

  const imagePath = args[0];
  const outIdx = args.indexOf("--out");
  const debugOutPath = outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1] : undefined;

  const report = await perceiveScreenshot(imagePath, debugOutPath);
  console.log(JSON.stringify(report, null, 2));
}
