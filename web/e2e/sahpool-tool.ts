// Spec-side driver for sahpool-tool.worker.mjs: a test-only worker, started
// in a same-origin page, that opens the replica's OPFS SAH pool with the
// installed sqlite-wasm build (patches included) and the app's own install
// options. It lets a spec leave a pool file exactly as a killed replica
// worker would, and read back what the app made of it.
//
// Start it from a page that neither boots the SPA nor spawns a replica
// worker (e.g. /healthz), and only while no other worker holds the pool:
// the pool's access handles are exclusive.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { Page } from "@playwright/test";
import { SAH_POOL_INSTALL_OPTIONS } from "../src/replica/openRetry";

export interface SqliteWasmSource { indexMjs: string; wasmBase64: string }

/** dist/index.mjs and dist/sqlite3.wasm of the installed (patched) package. */
export function readSqliteWasmSource(): SqliteWasmSource {
  const wasmPath = createRequire(import.meta.url).resolve("@sqlite.org/sqlite-wasm/sqlite3.wasm");
  return {
    indexMjs: readFileSync(path.join(path.dirname(wasmPath), "index.mjs"), "utf-8"),
    wasmBase64: readFileSync(wasmPath).toString("base64"),
  };
}

const TOOL_SOURCE = readFileSync(new URL("./sahpool-tool.worker.mjs", import.meta.url), "utf-8");

export interface SahpoolTool {
  /** The pool's file names; opens no database. */
  files(): Promise<string[]>;
  /** Open `file` in the pool, kept under the connection name `conn`. */
  open(conn: string, file: string): Promise<void>;
  /** Run `sql` on `conn`; rows as objects ([] for no result). */
  exec(conn: string, sql: string): Promise<Record<string, unknown>[]>;
  /** Terminate the worker as it is: open transactions and all. */
  kill(): Promise<void>;
  /** Close every connection, pause the pool (its access handles are closed
   * on return), then terminate the worker. */
  release(): Promise<void>;
}

interface ToolSlot { worker: Worker; indexUrl: string; wasmUrl: string }
type ToolWindow = Window & { __sahpoolTools?: ToolSlot[] };

let nextId = 0;

export async function startSahpoolTool(
  page: Page, source: SqliteWasmSource = readSqliteWasmSource(),
): Promise<SahpoolTool> {
  const index = await page.evaluate(({ toolSource, indexMjs, wasmBase64 }) => {
    const blobUrl = (parts: BlobPart[], type: string) =>
      URL.createObjectURL(new Blob(parts, { type }));
    const wasmBytes = Uint8Array.from(atob(wasmBase64), (c) => c.charCodeAt(0));
    const w = window as ToolWindow;
    w.__sahpoolTools ??= [];
    w.__sahpoolTools.push({
      worker: new Worker(blobUrl([toolSource], "text/javascript"), { type: "module" }),
      indexUrl: blobUrl([indexMjs], "text/javascript"),
      wasmUrl: blobUrl([wasmBytes], "application/wasm"),
    });
    return w.__sahpoolTools.length - 1;
  }, { toolSource: TOOL_SOURCE, ...source });

  const call = async <T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> => {
    const reply = await page.evaluate(({ index, id, cmd, args }) => {
      const { worker, indexUrl, wasmUrl } = (window as ToolWindow).__sahpoolTools![index];
      if (cmd === "install") args = { ...args, indexUrl, wasmUrl };
      return new Promise<{ ok: boolean; result?: unknown; error?: string }>((resolve) => {
        const onMessage = ({ data }: MessageEvent) => {
          if (data?.id !== id) return;
          worker.removeEventListener("message", onMessage);
          resolve(data);
        };
        worker.addEventListener("message", onMessage);
        worker.addEventListener("error", (event) => {
          resolve({ ok: false, error: `worker error: ${event.message}` });
        }, { once: true });
        worker.postMessage({ id, cmd, args });
      });
    }, { index, id: nextId++, cmd, args });
    if (!reply.ok) throw new Error(`sahpool tool ${cmd} failed: ${reply.error}`);
    return reply.result as T;
  };

  const terminate = () => page.evaluate((i) => {
    (window as ToolWindow).__sahpoolTools![i].worker.terminate();
  }, index);

  await call("install", { options: { ...SAH_POOL_INSTALL_OPTIONS } });

  return {
    files: () => call<string[]>("files"),
    open: async (conn, file) => { await call("open", { conn, file }); },
    exec: (conn, sql) => call<Record<string, unknown>[]>("exec", { conn, sql }),
    kill: terminate,
    release: async () => {
      await call("release");
      await terminate();
    },
  };
}
