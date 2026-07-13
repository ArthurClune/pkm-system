// pattern: Imperative Shell
// /api/ws client: JSON batch dispatch, keepalive pings (the server ignores
// inbound frames), and auto-reconnect on a fixed 2s timer until close().
import type { BlockOp } from "../api/ops";

export interface WsBatch {
  client_id: string;
  ts: number;
  ops: BlockOp[];
}

/** Post-commit journal nudge (server notify.SeqFrame): the replica pulls
 * the changes feed when one arrives. Best-effort — the cursor pull on
 * reconnect is the correctness mechanism. */
export interface WsSeq {
  type: "seq";
  seq: number;
}

export interface SocketHandle {
  close(): void;
}

const RECONNECT_MS = 2000;
const PING_MS = 30_000;

export function connectSocket(opts: {
  onBatch: (batch: WsBatch) => void;
  onStatus: (connected: boolean) => void;
  onSeq?: (frame: WsSeq) => void;
}): SocketHandle {
  let closed = false;
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const open = () => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${window.location.host}/api/ws`);
    ws.onopen = () => {
      opts.onStatus(true);
      pingTimer = setInterval(() => ws?.send("ping"), PING_MS);
    };
    ws.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as unknown;
      if (!msg) return;
      if ((msg as WsSeq).type === "seq") {
        opts.onSeq?.(msg as WsSeq);
        return;
      }
      if (!Array.isArray((msg as WsBatch).ops)) return;
      opts.onBatch(msg as WsBatch);
    };
    ws.onclose = () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      opts.onStatus(false);
      if (!closed) reconnectTimer = setTimeout(open, RECONNECT_MS);
    };
  };
  open();

  return {
    close() {
      closed = true;
      if (pingTimer) clearInterval(pingTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      ws?.close();
    },
  };
}
