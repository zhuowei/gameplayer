import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUNTIME_JS_PATH = resolve(HERE, "../runtime/gameplay-runtime.js");

interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl?: string;
}

export interface CliArgs {
  cmd: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseCliArgs(argv: string[]): CliArgs {
  const [cmd = "help", ...rest] = argv;
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i];
    if (tok.startsWith("--")) {
      const key = tok.slice(2);
      const eq = key.indexOf("=");
      if (eq !== -1) {
        flags[key.slice(0, eq)] = key.slice(eq + 1);
      } else if (i + 1 < rest.length && !rest[i + 1].startsWith("--")) {
        flags[key] = rest[++i];
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { cmd, positionals, flags };
}

class CdpSession {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.ws.addEventListener("message", (event) => {
      const msg = JSON.parse(String(event.data)) as {
        id?: number;
        result?: unknown;
        error?: { message: string };
      };
      if (msg.id !== undefined) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(msg.error.message));
          else entry.resolve(msg.result);
        }
      }
    });
  }

  static async connect(wsUrl: string): Promise<CdpSession> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener(
        "error",
        () => reject(new Error(`CDP WebSocket error connecting to ${wsUrl}`)),
        { once: true },
      );
    });
    return new CdpSession(ws);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evalValue<T = unknown>(expression: string): Promise<T> {
    const res = await this.send<{
      result: { value?: T; description?: string; type: string };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res.exceptionDetails) {
      throw new Error(
        res.exceptionDetails.exception?.description ?? res.exceptionDetails.text,
      );
    }
    return res.result.value as T;
  }

  close(): void {
    this.ws.close();
  }
}

async function listTargets(cdpBase: string): Promise<CdpTarget[]> {
  const res = await fetch(`${cdpBase.replace(/\/$/, "")}/json/list`);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${cdpBase}/json/list: HTTP ${res.status}`);
  }
  const targets = (await res.json()) as CdpTarget[];
  return targets.filter((t) => t.type === "page");
}

async function selectTarget(cdpBase: string, match?: string): Promise<CdpTarget> {
  const pages = await listTargets(cdpBase);
  if (pages.length === 0) {
    throw new Error(`No page targets found at ${cdpBase}`);
  }
  if (match) {
    const found = pages.find(
      (p) => p.url.includes(match) || p.title.includes(match),
    );
    if (!found) {
      throw new Error(
        `No page matched "${match}". Open pages: ${pages.map((p) => p.url).join(", ")}`,
      );
    }
    return found;
  }
  return pages[0];
}

async function ensureRuntimeInjected(cdp: CdpSession): Promise<boolean> {
  const hasApi = await cdp.evalValue<boolean>("Boolean(window.gameplayApi)");
  if (hasApi) return false;
  const src = readFileSync(RUNTIME_JS_PATH, "utf8");
  await cdp.evalValue(src);
  return true;
}

async function captureOverlayOrPageScreenshot(
  cdp: CdpSession,
  outPath: string,
): Promise<void> {
  const format = outPath.toLowerCase().endsWith(".png") ? "png" : "jpeg";
  const res = await cdp.send<{ data: string }>("Page.captureScreenshot", {
    format,
    quality: format === "jpeg" ? 85 : undefined,
  });
  writeFileSync(outPath, Buffer.from(res.data, "base64"));
}

async function main(): Promise<void> {
  const { cmd, positionals, flags } = parseCliArgs(process.argv.slice(2));
  const cdpBase =
    typeof flags.cdp === "string" ? flags.cdp : "http://localhost:9222";
  const match = typeof flags.match === "string" ? flags.match : undefined;
  const out = typeof flags.out === "string" ? flags.out : undefined;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    console.log(
      [
        "gameplay-browsertool (raw CDP client — no external dependencies)",
        "",
        "Commands:",
        "  pages [--cdp URL]",
        "  inject [--match SUBSTR] [--cdp URL]",
        "  eval <js_expr> [--match SUBSTR] [--cdp URL]",
        "  drive [--ms 3000] [--out sheet.jpg] [--match SUBSTR] [--cdp URL]",
        "  run <async_body_js> [--out sheet.jpg] [--match SUBSTR] [--cdp URL]",
        "  screenshot <out.png|jpg> [--match SUBSTR] [--cdp URL]",
      ].join("\n"),
    );
    return;
  }

  if (cmd === "pages") {
    const pages = await listTargets(cdpBase);
    console.log(JSON.stringify(pages, null, 2));
    return;
  }

  const target = await selectTarget(cdpBase, match);
  if (!target.webSocketDebuggerUrl) {
    throw new Error(`Target ${target.url} has no webSocketDebuggerUrl`);
  }
  const cdp = await CdpSession.connect(target.webSocketDebuggerUrl);

  try {
    if (cmd === "inject") {
      const injectedNow = await ensureRuntimeInjected(cdp);
      console.log(JSON.stringify({ ok: true, injectedNow, url: target.url }));
      return;
    }

    if (cmd === "eval") {
      const expr = positionals[0];
      if (!expr) throw new Error("Missing <js_expr>");
      const result = await cdp.evalValue(expr);
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (cmd === "screenshot") {
      const dest = positionals[0] ?? out;
      if (!dest) throw new Error("Missing output file path");
      await captureOverlayOrPageScreenshot(cdp, dest);
      console.log(JSON.stringify({ ok: true, saved: dest }));
      return;
    }

    if (cmd === "drive") {
      await ensureRuntimeInjected(cdp);
      const maxDurationMs =
        typeof flags.ms === "string" ? Number(flags.ms) : 3000;
      const steerBias =
        typeof flags.bias === "string" ? Number(flags.bias) : 0;
      const label = typeof flags.label === "string" ? flags.label : "servo";
      const result = await cdp.evalValue(
        `window.gameplayApi.driveServo(${JSON.stringify({
          maxDurationMs,
          steerBias,
          label,
          showSheetOverlay: true,
        })})`,
      );
      if (out) {
        await captureOverlayOrPageScreenshot(cdp, out);
      }
      console.log(JSON.stringify({ result, savedSheet: out ?? null }, null, 2));
      return;
    }

    if (cmd === "run") {
      const body = positionals[0];
      if (!body) throw new Error("Missing <async_body_js>");
      await ensureRuntimeInjected(cdp);
      const label = typeof flags.label === "string" ? flags.label : "chunk";
      const result = await cdp.evalValue(
        `window.gameplayApi.runChunk(async ({ api, shouldAbort, captureNow }) => { ${body} }, ${JSON.stringify(
          { label, showSheetOverlay: true },
        )})`,
      );
      if (out) {
        await captureOverlayOrPageScreenshot(cdp, out);
      }
      console.log(JSON.stringify({ result, savedSheet: out ?? null }, null, 2));
      return;
    }

    throw new Error(`Unknown command: ${cmd}`);
  } finally {
    cdp.close();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
