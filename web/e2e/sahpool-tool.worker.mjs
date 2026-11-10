// Test-only module worker that opens the replica's OPFS SAH pool directly,
// so a spec can write, kill, reopen and inspect pool files without the app.
// sahpool-tool.ts starts it from a blob URL and passes it blob URLs of the
// installed sqlite-wasm build (index.mjs) and its wasm binary.
//
// Protocol: every message is { id, cmd, args } and gets exactly one reply
// { id, ok: true, result } or { id, ok: false, error }. The first command
// is always "install".

/** @typedef {import("@sqlite.org/sqlite-wasm").SAHPoolUtil} SAHPoolUtil */
/** @typedef {import("@sqlite.org/sqlite-wasm").OpfsSAHPoolDatabase} PoolDb */
/** @typedef {import("@sqlite.org/sqlite-wasm").Sqlite3Static} Sqlite3Static */
/**
 * @typedef {Parameters<Sqlite3Static["installOpfsSAHPoolVfs"]>[0]}
 *   PoolOptions
 */
/**
 * @typedef {{ default: (config: { locateFile: () => string }) =>
 *   Promise<Sqlite3Static> }} SqliteBuild
 */
/**
 * @typedef {{ indexUrl: string, wasmUrl: string, options: PoolOptions }}
 *   InstallArgs
 * @typedef {{ id: number } & (
 *   | { cmd: "install", args: InstallArgs }
 *   | { cmd: "files" | "release" }
 *   | { cmd: "open", args: { conn: string, file: string } }
 *   | { cmd: "exec", args: { conn: string, sql: string } }
 * )} ToolRequest
 */

/** @type {SAHPoolUtil | null} */
let pool = null;
/** @type {Map<string, PoolDb>} */
const conns = new Map();

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A worker that was terminated or closed releases its access handles
// asynchronously, so installing right after it can meet a handle that is
// still held. Retry that contention only; anything else is a real failure.
const CONTENTION = /access handle|createSyncAccessHandle/i;
const INSTALL_DEADLINE_MS = 5000;

/**
 * The build at a blob URL has no static type: check it exports an init.
 * @param {unknown} mod
 * @returns {mod is SqliteBuild}
 */
function isSqliteBuild(mod) {
  return typeof mod === "object" && mod !== null && "default" in mod
    && typeof mod.default === "function";
}

/** @param {InstallArgs} args */
async function install({ indexUrl, wasmUrl, options }) {
  /** @type {unknown} */
  const build = await import(indexUrl);
  if (!isSqliteBuild(build)) throw new Error(`${indexUrl} exports no init`);
  const sqlite3 = await build.default({ locateFile: () => wasmUrl });
  const deadline = Date.now() + INSTALL_DEADLINE_MS;
  for (;;) {
    try {
      pool = await sqlite3.installOpfsSAHPoolVfs({ ...options });
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!CONTENTION.test(message) || Date.now() > deadline) throw error;
      await sleep(100);
    }
  }
}

function installed() {
  if (pool === null) throw new Error("the pool is not installed");
  return pool;
}

/** @param {string} name */
function conn(name) {
  const db = conns.get(name);
  if (!db) throw new Error(`no open connection "${name}"`);
  return db;
}

/** @param {ToolRequest} request */
async function run(request) {
  switch (request.cmd) {
    case "install":
      return install(request.args);
    case "files":
      return installed().getFileNames();
    case "open":
      conns.set(request.args.conn, new (installed().OpfsSAHPoolDb)(request.args.file));
      return null;
    case "exec":
      return conn(request.args.conn).exec({
        sql: request.args.sql, returnValue: "resultRows", rowMode: "object",
      });
    case "release":
      for (const db of conns.values()) db.close();
      conns.clear();
      installed().pauseVfs();
      return null;
    default:
      throw new Error(`unknown command "${JSON.stringify(request)}"`);
  }
}

/** @param {MessageEvent<ToolRequest>} event */
self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ id: data.id, ok: true, result: await run(data) });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    self.postMessage({ id: data.id, ok: false, error: message });
  }
};
