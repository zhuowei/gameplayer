import { describe, expect, test } from "bun:test";
import sharp from "sharp";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  analyzeDisparityMap,
  analyzeOpenCvGeometry,
  detectScreenshotLayout,
  perceiveScreenshot,
} from "./index";

describe("third-party perception CLI (Depth Anything V2 + OpenCV + sharp)", () => {
  test("detectScreenshotLayout distinguishes letterboxed 4x2 contact sheet from raw viewport", () => {
    const w = 1512;
    const h = 1488;
    const buf = new Uint8Array(w * h * 3);
    // Fill #0b1120 background
    for (let i = 0; i < buf.length; i += 3) {
      buf[i] = 11;
      buf[i + 1] = 17;
      buf[i + 2] = 32;
    }
    // Paint centered 1479 x 815 contact sheet box
    for (let y = 336; y < 336 + 815; y++) {
      for (let x = 16; x < 16 + 1479; x++) {
        const idx = (y * w + x) * 3;
        buf[idx] = 120;
        buf[idx + 1] = 130;
        buf[idx + 2] = 140;
      }
    }

    const sheetLayout = detectScreenshotLayout(buf, w, h, 3);
    expect(sheetLayout.isContactSheet).toBe(true);
    expect(sheetLayout.tile1Box).not.toBeNull();
    expect(sheetLayout.activeViewBox.left).toBeGreaterThan(1000);
    expect(sheetLayout.minimapBox.top).toBeGreaterThan(900);

    // Raw game screenshot without #0b1120 letterbox
    const rawBuf = new Uint8Array(800 * 600 * 3).fill(140);
    const rawLayout = detectScreenshotLayout(rawBuf, 800, 600, 3);
    expect(rawLayout.isContactSheet).toBe(false);
    expect(rawLayout.activeViewBox).toEqual({ left: 0, top: 0, width: 800, height: 600 });
  });

  test("analyzeDisparityMap catches narrow center obstacle and selects contiguous open corridor", () => {
    const dw = 160;
    const dh = 120;
    const disp = new Float32Array(dw * dh);
    for (let y = 0; y < dh; y++) {
      for (let x = 0; x < dw; x++) {
        // Sky / far background = 0.2, near ground = 5.0
        let d = y < 38 ? 0.2 : 0.4 + ((y - 38) / 82) * 4.8;
        // Thin vertical post in center sector (x: 76..85, y: 28..65) with close disparity 3.2
        if (x >= 76 && x <= 85 && y >= 28 && y <= 65) {
          d = 3.2;
        }
        // Slightly deeper corridor on right side (x > 90)
        if (x > 90 && y >= 32 && y <= 56) {
          d *= 0.82;
        }
        disp[y * dw + x] = d;
      }
    }

    const res = analyzeDisparityMap(disp, dw, dh);
    expect(res.wallOrObstacleAhead).toBe(true);
    expect(res.centerClearance).toBeLessThan(0.45);
    // Mode-seeking picks right corridor (> +0.35) instead of cancelling left & right to 0
    expect(res.corridorOffsetX).toBeGreaterThan(0.35);
  });

  test("analyzeOpenCvGeometry extracts Hough vanishing point and minimap ribbon turn ahead", async () => {
    const vw = 320;
    const vh = 240;
    const viewRgb = new Uint8Array(vw * vh * 3).fill(90);
    // Draw perspective road boundary lines converging toward x = 230 (+0.44) at y = 86
    const vpX = 230;
    const vpY = 86;
    for (const baseX of [40, 290]) {
      const baseY = 180;
      for (let step = 0; step <= 120; step++) {
        const t = step / 120;
        const px = Math.round(baseX + (vpX - baseX) * t);
        const py = Math.round(baseY + (vpY - baseY) * t);
        if (px >= 1 && px < vw - 1 && py >= 90 && py < 180) {
          for (const dx of [-1, 0, 1]) {
            const idx = (py * vw + (px + dx)) * 3;
            viewRgb[idx] = 245;
            viewRgb[idx + 1] = 245;
            viewRgb[idx + 2] = 245;
          }
        }
      }
    }

    // Synthetic minimap (160x160) with sand background, white track curving right, and player moving up
    const mw = 160;
    const mh = 160;
    const mmRgb = new Uint8Array(mw * mh * 3);
    for (let i = 0; i < mmRgb.length; i += 3) {
      mmRgb[i] = 195;
      mmRgb[i + 1] = 178;
      mmRgb[i + 2] = 128;
    }
    // White ribbon goes straight up to (80, 95), then curves sharply right toward (125, 60)
    for (let y = 140; y >= 95; y--) {
      for (let dx = -2; dx <= 2; dx++) {
        const idx = (y * mw + (80 + dx)) * 3;
        mmRgb[idx] = 245;
        mmRgb[idx + 1] = 245;
        mmRgb[idx + 2] = 240;
      }
    }
    for (let s = 0; s <= 50; s++) {
      const t = s / 50;
      const rx = Math.round(80 + 42 * t);
      const ry = Math.round(95 - 32 * t);
      for (let dx = -2; dx <= 2; dx++) {
        const idx = (ry * mw + (rx + dx)) * 3;
        mmRgb[idx] = 245;
        mmRgb[idx + 1] = 245;
        mmRgb[idx + 2] = 240;
      }
    }

    // Paint player red marker with dark outline at (80, 100) in FINAL MINIMAP
    const paintMarker = (buf: Uint8Array, bw: number, cx: number, cy: number) => {
      for (let dy = -3; dy <= 3; dy++) {
        for (let dx = -3; dx <= 3; dx++) {
          const idx = ((cy + dy) * bw + (cx + dx)) * 3;
          const isEdge = Math.abs(dx) === 3 || Math.abs(dy) === 3;
          buf[idx] = isEdge ? 20 : 235;
          buf[idx + 1] = isEdge ? 20 : 25;
          buf[idx + 2] = isEdge ? 20 : 25;
        }
      }
    };
    paintMarker(mmRgb, mw, 80, 100);

    // Paint earlier player marker lower at (0.50, 0.75) inside Tile 1 minimap region [0..73, 139..237]
    const tile1Rgb = new Uint8Array(vw * vh * 3).fill(140);
    const t1MmX = Math.round(0.5 * Math.floor(vw * 0.23));
    const t1MmY = Math.floor(vh * 0.58) + Math.round(0.75 * Math.floor(vh * 0.41));
    paintMarker(tile1Rgb, vw, t1MmX, t1MmY);

    const cvOut = await analyzeOpenCvGeometry(
      viewRgb,
      vw,
      vh,
      mmRgb,
      mw,
      mh,
      tile1Rgb,
      vw,
      vh,
    );

    expect(cvOut.roadEdgeLines).toBeGreaterThanOrEqual(2);
    expect(cvOut.vanishingPointX).not.toBeNull();
    expect(cvOut.vanishingPointX!).toBeGreaterThan(0.2);
    expect(cvOut.minimap.playerFound).toBe(true);
    expect(cvOut.minimap.onRibbon).toBe(true);
    expect(cvOut.minimap.headingDeg).toBeLessThan(-70); // moving up (-90 deg)
    expect(cvOut.minimap.turnAheadDeg).toBeGreaterThan(20); // curving right ahead!
  });

  test("perceiveScreenshot runs offline Depth Anything V2 + OpenCV end-to-end", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "perceive-test-"));
    const imgPath = path.join(tmpDir, "frame.jpg");
    const debugPath = path.join(tmpDir, "debug.jpg");

    try {
      const w = 320;
      const h = 240;
      const rgb = new Uint8Array(w * h * 3);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = (y * w + x) * 3;
          if (y < 85) {
            rgb[idx] = 115;
            rgb[idx + 1] = 180;
            rgb[idx + 2] = 245;
          } else {
            rgb[idx] = 128;
            rgb[idx + 1] = 124;
            rgb[idx + 2] = 118;
          }
        }
      }
      await sharp(rgb, { raw: { width: w, height: h, channels: 3 } })
        .jpeg({ quality: 90 })
        .toFile(imgPath);

      const report = await perceiveScreenshot(imgPath, debugPath);
      expect(report.mode).toBe("raw_viewport");
      expect(report.depth3d.sectorClearanceLtoR.length).toBe(7);
      const stat = await fs.stat(debugPath);
      expect(stat.size).toBeGreaterThan(1000);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
