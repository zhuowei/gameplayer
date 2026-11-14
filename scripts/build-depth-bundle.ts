#!/usr/bin/env bun
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(__dirname, "..");

const ORT_BUNDLE_PATH = path.resolve(
  WORKSPACE_ROOT,
  "node_modules/onnxruntime-web/dist/ort.wasm.bundle.min.mjs",
);
const WASM_PATH = path.resolve(
  WORKSPACE_ROOT,
  "node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm",
);
const MODEL_PATH = path.resolve(
  WORKSPACE_ROOT,
  ".cache/models/onnx-community/depth-anything-v2-small/onnx/model_quantized.onnx",
);
const OUTPUT_PATH = path.resolve(
  WORKSPACE_ROOT,
  ".cache/gameplay-depth-bundle.js",
);

function main(): void {
  if (!fs.existsSync(MODEL_PATH)) {
    console.warn(
      `[build-depth-bundle] Model not found at ${MODEL_PATH}; skipping .cache/gameplay-depth-bundle.js generation.`,
    );
    return;
  }
  if (!fs.existsSync(ORT_BUNDLE_PATH) || !fs.existsSync(WASM_PATH)) {
    console.warn(
      `[build-depth-bundle] onnxruntime-web dist files not found; skipping .cache/gameplay-depth-bundle.js generation.`,
    );
    return;
  }

  const rawMjs = fs.readFileSync(ORT_BUNDLE_PATH, "utf8").trimEnd();
  const exportMatch = rawMjs.match(/export\{([^}]+)\};[\s\S]*$/);
  if (!exportMatch || exportMatch.index === undefined) {
    throw new Error("Unexpected tail format in ort.wasm.bundle.min.mjs");
  }
  const bindings = exportMatch[1]
    .split(",")
    .map((part) => {
      const [local, exported] = part.trim().split(/\s+as\s+/);
      return `${exported || local}:${local}`;
    })
    .join(",");

  const ortIifeJs =
    `(()=>{const __metaUrl=(typeof self!=="undefined"&&self.location&&self.location.href)||"https://localhost/";` +
    rawMjs.slice(0, exportMatch.index).replaceAll("import.meta.url", "__metaUrl") +
    `;globalThis.ort={${bindings}};})();`;

  const wasmBase64 = fs.readFileSync(WASM_PATH).toString("base64");
  const modelBase64 = fs.readFileSync(MODEL_PATH).toString("base64");

  const bundleSource = `// Auto-generated offline 3D depth asset bundle for window.gameplayApi v5\n(function(){window.__gameplayDepthAssets={ortIifeJs:${JSON.stringify(ortIifeJs)},wasmBase64:${JSON.stringify(wasmBase64)},modelBase64:${JSON.stringify(modelBase64)},inputWidth:280,inputHeight:210};console.log("[gameplay-depth-bundle] loaded Depth Anything V2 Small + ORT WASM assets (280x210)");})();\n`;

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, bundleSource, "utf8");
  const mb = (Buffer.byteLength(bundleSource, "utf8") / (1024 * 1024)).toFixed(2);
  console.log(`[build-depth-bundle] Wrote ${OUTPUT_PATH} (${mb} MB)`);
}

main();
