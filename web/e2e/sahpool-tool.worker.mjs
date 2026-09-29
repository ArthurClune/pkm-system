// Test-only module worker that opens the replica's OPFS SAH pool directly,
// so a spec can write, kill, reopen and inspect pool files without the app.
// sahpool-tool.ts starts it from a blob URL and passes it blob URLs of the
// installed sqlite-wasm build (index.mjs) and its wasm binary.
//
// Protocol: every message is { id, cmd, args } and gets exactly one reply
// { id, ok: true, result } or { id, ok: false, error }. The first command
// is always "install".

let pool = null;
const conns = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A worker that was terminated or closed releases its access handles
// asynchronously, so installing right after it can meet a handle that is
// still held. Retry that contention only; anything else is a real failure.
const CONTENTION = /access handle|createSyncAccessHandle/i;
const INSTALL_DEADLINE_MS = 5000;

async function install({ indexUrl, wasmUrl, options }) {
  const { default: init } = await import(indexUrl);
  const sqlite3 = await init({ locateFile: () => wasmUrl });
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

function conn(name) {
  const db = conns.get(name);
  if (!db) throw new Error(`no open connection "${name}"`);
  return db;
}

const commands = {
  install,
  files: () => pool.getFileNames(),
  open({ conn: name, file }) {
    conns.set(name, new pool.OpfsSAHPoolDb(file));
    return null;
  },
  exec({ conn: name, sql }) {
    return conn(name).exec({ sql, returnValue: "resultRows", rowMode: "object" });
  },
  release() {
    for (const db of conns.values()) db.close();
    conns.clear();
    pool.pauseVfs();
    return null;
  },
};

self.onmessage = async ({ data: { id, cmd, args } }) => {
  try {
    const run = commands[cmd];
    if (!run) throw new Error(`unknown command "${cmd}"`);
    self.postMessage({ id, ok: true, result: await run(args ?? {}) });
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    self.postMessage({ id, ok: false, error: message });
  }
};
