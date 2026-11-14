export interface Depth3DResult {
  corridorOffsetX: number;
  centerClearance: number;
  maxClearance: number;
  wallOrObstacleAhead: boolean;
  sectorClearanceLtoR: number[];
  inferMs: number;
  timestamp: number;
}

export type DepthEngineMode =
  | "uninitialized"
  | "initializing"
  | "worker"
  | "main_thread"
  | "unavailable"
  | "error";

export interface DepthEngineStatus {
  ready: boolean;
  mode: DepthEngineMode;
  inputSize: [number, number];
  inferencesCompleted: number;
  lastInferMs: number;
  lastResult: Depth3DResult | null;
  error?: string;
}

export interface DepthEngineLike {
  init(): Promise<DepthEngineStatus>;
  getStatus(): DepthEngineStatus;
  submitFrameNonBlocking(
    surface: HTMLCanvasElement | HTMLVideoElement,
  ): Depth3DResult | null;
  inferOnce(
    surface: HTMLCanvasElement | HTMLVideoElement,
  ): Promise<Depth3DResult | null>;
}

interface RawDepthBundleAssets {
  ortIifeJs: string;
  wasmBase64: string;
  modelBase64: string;
  inputWidth?: number;
  inputHeight?: number;
}

interface DecodedDepthAssets {
  ortIifeJs: string;
  wasmBytes: Uint8Array;
  modelBytes: Uint8Array;
  inputWidth: number;
  inputHeight: number;
}

interface OrtTensorLike {
  data: Float32Array;
  dims: number[];
}

interface OrtSessionLike {
  inputNames: string[];
  outputNames: string[];
  run(
    feeds: Record<string, unknown>,
  ): Promise<Record<string, OrtTensorLike>>;
}

interface OrtGlobalLike {
  env: {
    wasm: {
      numThreads: number;
      proxy: boolean;
      wasmBinary?: Uint8Array;
    };
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
  InferenceSession: {
    create(
      model: Uint8Array,
      options: { executionProviders: string[] },
    ): Promise<OrtSessionLike>;
  };
}

const DEFAULT_WIDTH = 280;
const DEFAULT_HEIGHT = 210;
const IMAGENET_MEAN = [0.485, 0.456, 0.406] as const;
const IMAGENET_STD = [0.229, 0.224, 0.225] as const;

/**
 * Converts an RGBA image buffer to ImageNet-normalized planar NCHW float32 tensor [1, 3, h, w].
 * Depth Anything V2 Small must never be run below 280x210 or ViT positional embeddings collapse.
 */
export function rgbaToNormalizedChwTensor(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
): Float32Array {
  const planeSize = w * h;
  const out = new Float32Array(3 * planeSize);
  const inv255 = 1 / 255;
  const invStdR = 1 / IMAGENET_STD[0];
  const invStdG = 1 / IMAGENET_STD[1];
  const invStdB = 1 / IMAGENET_STD[2];

  for (let i = 0; i < planeSize; i++) {
    const p = i * 4;
    out[i] = (rgba[p] * inv255 - IMAGENET_MEAN[0]) * invStdR;
    out[planeSize + i] = (rgba[p + 1] * inv255 - IMAGENET_MEAN[1]) * invStdG;
    out[2 * planeSize + i] =
      (rgba[p + 2] * inv255 - IMAGENET_MEAN[2]) * invStdB;
  }
  return out;
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
): Omit<Depth3DResult, "inferMs" | "timestamp"> {
  const numSectors = 7;
  const rawSectorDisp = new Float64Array(numSectors);

  // Sample horizon-to-midground band (y: 0.28..0.46) strictly above player kart head (y >= 0.48)
  const y0 = Math.max(0, Math.floor(dh * 0.28));
  const y1 = Math.max(y0 + 1, Math.floor(dh * 0.46));
  const xMargin = Math.floor(dw * 0.05);
  const spanW = dw - 2 * xMargin;

  for (let s = 0; s < numSectors; s++) {
    const sx0 = xMargin + Math.floor((s / numSectors) * spanW);
    const sx1 = Math.max(
      sx0 + 1,
      xMargin + Math.floor(((s + 1) / numSectors) * spanW),
    );
    const vals: number[] = [];
    for (let y = y0; y < y1; y++) {
      for (let x = sx0; x < sx1; x++) {
        vals.push(disparity[y * dw + x]);
      }
    }
    vals.sort((a, b) => a - b);
    // 88th percentile catches thin vertical posts/trees (~15-20% of sector width)
    const p88 =
      vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.88))] ?? 0;
    rawSectorDisp[s] = p88;
  }

  // Reference near-ground disparity flanking player wheels (y: 0.72..0.84)
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

  const sectorClearanceLtoR: number[] = [];
  for (let s = 0; s < numSectors; s++) {
    const normDisp = (rawSectorDisp[s] - farRefDisp) / dispRange;
    const clearance = Math.max(0, Math.min(1, 1 - normDisp * 1.45));
    sectorClearanceLtoR.push(Number(clearance.toFixed(3)));
  }

  const maxClearance = Math.max(...sectorClearanceLtoR);
  const centerClearance = sectorClearanceLtoR[3];

  // Mode-seeking contiguous corridor selection avoids averaging split obstacles to 0.0
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

function decodeBase64ToUint8Array(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes;
}

const WORKER_TAIL_SCRIPT = `
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

interface RuntimeSingletonState {
  worker: Worker | null;
  mainSession: OrtSessionLike | null;
  ortRef: OrtGlobalLike | null;
  mode: DepthEngineMode;
  ready: boolean;
  inputWidth: number;
  inputHeight: number;
  error?: string;
}

export class BrowserDepthEngine implements DepthEngineLike {
  private scratchCanvas: HTMLCanvasElement | null = null;
  private scratchCtx: CanvasRenderingContext2D | null = null;
  private status: DepthEngineStatus = {
    ready: false,
    mode: "uninitialized",
    inputSize: [DEFAULT_WIDTH, DEFAULT_HEIGHT],
    inferencesCompleted: 0,
    lastInferMs: 0,
    lastResult: null,
  };
  private initPromise: Promise<DepthEngineStatus> | null = null;
  private busy = false;
  private lastSubmitAt = -Infinity;
  private nextReqId = 1;
  private workerPending = new Map<
    number,
    {
      resolve: (res: Depth3DResult | null) => void;
    }
  >();

  private getGlobalStore(): Record<string, unknown> {
    return (typeof window !== "undefined"
      ? window
      : globalThis) as unknown as Record<string, unknown>;
  }

  private getDecodedAssets(): DecodedDepthAssets | null {
    const g = this.getGlobalStore();
    const existing = g.__gameplayDepthDecoded as DecodedDepthAssets | undefined;
    if (existing && existing.wasmBytes?.byteLength > 0 && existing.modelBytes?.byteLength > 0) {
      return existing;
    }
    const raw = g.__gameplayDepthAssets as RawDepthBundleAssets | undefined;
    if (!raw || !raw.ortIifeJs || !raw.wasmBase64 || !raw.modelBase64) {
      return null;
    }
    const inputWidth = Math.max(DEFAULT_WIDTH, raw.inputWidth ?? DEFAULT_WIDTH);
    const inputHeight = Math.max(DEFAULT_HEIGHT, raw.inputHeight ?? DEFAULT_HEIGHT);
    const decoded: DecodedDepthAssets = {
      ortIifeJs: raw.ortIifeJs,
      wasmBytes: decodeBase64ToUint8Array(raw.wasmBase64),
      modelBytes: decodeBase64ToUint8Array(raw.modelBase64),
      inputWidth,
      inputHeight,
    };
    g.__gameplayDepthDecoded = decoded;
    // Free massive base64 strings immediately after decoding
    raw.wasmBase64 = "";
    raw.modelBase64 = "";
    delete g.__gameplayDepthAssets;
    return decoded;
  }

  private ensureScratchCanvas(
    w: number,
    h: number,
  ): CanvasRenderingContext2D | null {
    if (typeof document === "undefined") return null;
    if (!this.scratchCanvas) {
      this.scratchCanvas = document.createElement("canvas");
    }
    if (this.scratchCanvas.width !== w) this.scratchCanvas.width = w;
    if (this.scratchCanvas.height !== h) this.scratchCanvas.height = h;
    if (!this.scratchCtx) {
      this.scratchCtx = this.scratchCanvas.getContext("2d", {
        willReadFrequently: true,
      });
    }
    return this.scratchCtx;
  }

  private extractChw(
    surface: HTMLCanvasElement | HTMLVideoElement,
  ): { chw: Float32Array; width: number; height: number } | null {
    const [w, h] = this.status.inputSize;
    const ctx = this.ensureScratchCanvas(w, h);
    if (!ctx) return null;
    ctx.drawImage(surface, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const chw = rgbaToNormalizedChwTensor(img.data, w, h);
    return { chw, width: w, height: h };
  }

  private attachWorkerListener(worker: Worker): void {
    worker.onmessage = (ev: MessageEvent) => {
      const msg = ev.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "result") {
        const disp = new Float32Array(msg.dispBuffer as ArrayBuffer);
        const parsed = analyzeDisparityMap(disp, msg.dw, msg.dh);
        const res: Depth3DResult = {
          ...parsed,
          inferMs: Number(msg.inferMs ?? 0),
          timestamp: performance.now(),
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

  private getSingleton(): RuntimeSingletonState | null {
    const s = this.getGlobalStore().__gameplayDepthSingleton as
      | RuntimeSingletonState
      | undefined;
    return s ?? null;
  }

  private setSingleton(state: RuntimeSingletonState): void {
    this.getGlobalStore().__gameplayDepthSingleton = state;
  }

  async init(): Promise<DepthEngineStatus> {
    if (this.status.ready) return this.getStatus();
    if (this.initPromise) return this.initPromise;

    const existingSingleton = this.getSingleton();
    if (existingSingleton && existingSingleton.ready) {
      this.status.mode = existingSingleton.mode;
      this.status.ready = true;
      this.status.inputSize = [
        existingSingleton.inputWidth,
        existingSingleton.inputHeight,
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
      this.status.error =
        "No __gameplayDepthAssets bundle found; call evaluate_script with .cache/gameplay-depth-bundle.js first";
      return this.getStatus();
    }

    this.status.mode = "initializing";
    this.status.inputSize = [decoded.inputWidth, decoded.inputHeight];
    this.status.error = undefined;

    this.initPromise = (async () => {
      // 1. Primary path: Non-blocking Blob Web Worker
      let workerError = "";
      if (typeof Worker !== "undefined" && typeof Blob !== "undefined") {
        try {
          const blob = new Blob([decoded.ortIifeJs, "\n", WORKER_TAIL_SCRIPT], {
            type: "application/javascript",
          });
          const blobUrl = URL.createObjectURL(blob);
          const worker = new Worker(blobUrl);

          await new Promise<void>((resolve, reject) => {
            const timeoutId = setTimeout(() => {
              reject(new Error("Depth worker init timeout (8000ms)"));
            }, 8000);

            worker.onmessage = (ev: MessageEvent) => {
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
              reject(
                new Error(err?.message || "Worker blocked or crashed on boot"),
              );
            };

            const wasmCopy = decoded.wasmBytes.slice(0).buffer;
            const modelCopy = decoded.modelBytes.slice(0).buffer;
            worker.postMessage(
              {
                type: "init",
                wasmBuffer: wasmCopy,
                modelBuffer: modelCopy,
              },
              [wasmCopy, modelCopy],
            );
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
            inputHeight: decoded.inputHeight,
          });
          return this.getStatus();
        } catch (err) {
          workerError = err instanceof Error ? err.message : String(err);
        }
      } else {
        workerError = "Worker/Blob API unavailable";
      }

      // 2. Fallback path: Main-thread ORT session (discrete pre-segment / pre-unwedge inference)
      try {
        const g = this.getGlobalStore();
        if (!g.ort) {
          new Function(decoded.ortIifeJs)();
        }
        const ort = g.ort as OrtGlobalLike | undefined;
        if (!ort) {
          throw new Error("Failed to evaluate ORT runtime on main thread");
        }
        ort.env.wasm.numThreads = 1;
        ort.env.wasm.proxy = false;
        ort.env.wasm.wasmBinary = decoded.wasmBytes.slice(0);
        const session = await ort.InferenceSession.create(
          decoded.modelBytes.slice(0),
          { executionProviders: ["wasm"] },
        );
        this.status.mode = "main_thread";
        this.status.ready = true;
        this.status.error = workerError
          ? `worker_fallback: ${workerError}`
          : undefined;
        this.setSingleton({
          worker: null,
          mainSession: session,
          ortRef: ort,
          mode: "main_thread",
          ready: true,
          inputWidth: decoded.inputWidth,
          inputHeight: decoded.inputHeight,
          error: this.status.error,
        });
        return this.getStatus();
      } catch (fallbackErr) {
        const fbMsg =
          fallbackErr instanceof Error
            ? fallbackErr.message
            : String(fallbackErr);
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

  getStatus(): DepthEngineStatus {
    return {
      ...this.status,
      inputSize: [...this.status.inputSize],
      lastResult: this.status.lastResult
        ? {
            ...this.status.lastResult,
            sectorClearanceLtoR: [
              ...this.status.lastResult.sectorClearanceLtoR,
            ],
          }
        : null,
    };
  }

  submitFrameNonBlocking(
    surface: HTMLCanvasElement | HTMLVideoElement,
  ): Depth3DResult | null {
    const singleton = this.getSingleton();
    if (
      this.status.ready &&
      this.status.mode === "worker" &&
      singleton?.worker &&
      !this.busy
    ) {
      const now = performance.now();
      if (now - this.lastSubmitAt >= 120) {
        const extracted = this.extractChw(surface);
        if (extracted) {
          this.busy = true;
          this.lastSubmitAt = now;
          const reqId = this.nextReqId++;
          singleton.worker.postMessage(
            {
              type: "infer",
              id: reqId,
              chwBuffer: extracted.chw.buffer,
              width: extracted.width,
              height: extracted.height,
            },
            [extracted.chw.buffer],
          );
        }
      }
    }
    return this.status.lastResult;
  }

  async inferOnce(
    surface: HTMLCanvasElement | HTMLVideoElement,
  ): Promise<Depth3DResult | null> {
    if (!this.status.ready) {
      await this.init();
    }
    const singleton = this.getSingleton();
    if (!this.status.ready || !singleton) return null;

    const extracted = this.extractChw(surface);
    if (!extracted) return null;

    if (this.status.mode === "worker" && singleton.worker) {
      if (this.busy) {
        return this.status.lastResult;
      }
      this.busy = true;
      this.lastSubmitAt = performance.now();
      const reqId = this.nextReqId++;
      return await new Promise<Depth3DResult | null>((resolve) => {
        const timeoutId = setTimeout(() => {
          this.workerPending.delete(reqId);
          this.busy = false;
          resolve(this.status.lastResult);
        }, 4000);
        this.workerPending.set(reqId, {
          resolve: (res) => {
            clearTimeout(timeoutId);
            resolve(res);
          },
        });
        singleton.worker!.postMessage(
          {
            type: "infer",
            id: reqId,
            chwBuffer: extracted.chw.buffer,
            width: extracted.width,
            height: extracted.height,
          },
          [extracted.chw.buffer],
        );
      });
    }

    if (
      this.status.mode === "main_thread" &&
      singleton.mainSession &&
      singleton.ortRef
    ) {
      if (this.busy) return this.status.lastResult;
      this.busy = true;
      try {
        const t0 = performance.now();
        const sess = singleton.mainSession;
        const ort = singleton.ortRef;
        const tensor = new ort.Tensor("float32", extracted.chw, [
          1,
          3,
          extracted.height,
          extracted.width,
        ]);
        const outMap = await sess.run({ [sess.inputNames[0]]: tensor });
        const outTensor = outMap[sess.outputNames[0]];
        const dims = outTensor.dims;
        const dh = dims.length === 3 ? dims[1] : dims[0];
        const dw = dims.length === 3 ? dims[2] : dims[1];
        const parsed = analyzeDisparityMap(outTensor.data, dw, dh);
        const inferMs = performance.now() - t0;
        const res: Depth3DResult = {
          ...parsed,
          inferMs,
          timestamp: performance.now(),
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
