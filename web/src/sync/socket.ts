// pattern: Imperative Shell
// /api/ws client: JSON batch dispatch, keepalive pings (the server ignores
// inbound frames), and reconnect-until-close() under one connectivity policy
// (pkm-d6i6): exponential backoff (reconnectBackoff.ts), no attempts at all
// while the tab is hidden, and an immediate attempt the moment the tab comes
// back or the browser says the network is up. The old fixed 2 s loop retried
// a dead link 30 times a minute for as long as the tab was open, foreground
// or not, which is what keeps a mobile radio out of low power.
import type { BlockOp } from "../api/ops";
import { reconnectDelayMs } from "./reconnectBackoff";

export interface WsBatch {
  client_id: string;
  ts: number;
  ops: BlockOp[];
}

/** Post-commit journal nudge (server notify.SeqFrame): the replica pulls
 * the changes feed when one arrives. A forced frame carries the real journal
 * maximum plus the committed generation and pulls even at an equal cursor;
 * it never fabricates a future sequence. Best-effort — the cursor pull on
 * reconnect is the correctness mechanism. */
export interface WsSeq {
  type: "seq";
  seq: number;
  force?: boolean;
  generation?: string;
}

export interface SocketHandle {
  close(): void;
}

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
  let priorFailures = 0;
  // A reconnect that is due but not scheduled, because the tab is hidden: no
  // timer runs while hidden, so the return to visibility is what starts it.
  let deferredWhileHidden = false;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  /** Between a drop and the next attempt — the only state in which hurrying
   * a reconnect makes sense. */
  const waitingToReconnect = (): boolean =>
    reconnectTimer !== null || deferredWhileHidden;

  const scheduleReconnect = (): void => {
    if (closed || waitingToReconnect()) return;
    if (document.hidden) { deferredWhileHidden = true; return; }
    const delay = reconnectDelayMs(priorFailures);
    priorFailures += 1;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open(); }, delay);
  };

  /** Short-circuit a wait on fresh evidence the link may be back. Does
   * nothing with a socket open or an attempt in flight: there is nothing to
   * hurry, and a second WebSocket would leak the first. */
  const reconnectNow = (): void => {
    if (closed || !waitingToReconnect()) return;
    clearReconnectTimer();
    deferredWhileHidden = false;
    open();
  };

  const onVisibilityChange = (): void => {
    if (!document.hidden) { reconnectNow(); return; }
    // Going hidden mid-wait: remember the attempt rather than dropping it,
    // so coming back to the tab reconnects at once instead of after a
    // backoff the hidden period never spent.
    if (reconnectTimer !== null) {
      clearReconnectTimer();
      deferredWhileHidden = true;
    }
  };

  const open = (): void => {
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const sock = new WebSocket(`${proto}//${window.location.host}/api/ws`);
    ws = sock;
    sock.onopen = () => {
      priorFailures = 0; // a real connection is what resets the backoff
      opts.onStatus(true);
      pingTimer = setInterval(() => sock.send("ping"), PING_MS);
    };
    sock.onmessage = (ev: MessageEvent) => {
      const msg = JSON.parse(String(ev.data)) as unknown;
      if (!msg) return;
      if ((msg as WsSeq).type === "seq") {
        opts.onSeq?.(msg as WsSeq);
        return;
      }
      if (!Array.isArray((msg as WsBatch).ops)) return;
      opts.onBatch(msg as WsBatch);
    };
    sock.onclose = () => {
      // A socket a hurried reconnect already superseded must neither report
      // status nor schedule an attempt of its own.
      if (ws !== sock) return;
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      opts.onStatus(false);
      scheduleReconnect();
    };
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", reconnectNow);
  open();

  return {
    close() {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", reconnectNow);
      if (pingTimer) clearInterval(pingTimer);
      clearReconnectTimer();
      ws?.close();
    },
  };
}
