// pattern: Imperative Shell
// /api/ws client: JSON batch dispatch, keepalive pings (the server ignores
// inbound frames), and reconnect-until-close() under one connectivity policy
// (pkm-d6i6): exponential backoff (reconnectBackoff.ts), no attempts at all
// while the tab is hidden, an immediate attempt the moment the tab comes back,
// and one on `online` too -- but never sooner than the backoff the schedule
// would have used, since `online` can fire repeatedly. The old fixed 2 s loop retried
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
  // When the last attempt was started, so a short-circuit can be held to the
  // same delay as the timer it replaces.
  let lastAttemptAt = 0;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  /** Between a drop and the next attempt — the only state in which hurrying
   * a reconnect makes sense. */
  const waitingToReconnect = (): boolean =>
    reconnectTimer !== null || deferredWhileHidden;

  /** Every reconnect goes through here, scheduled or hurried, because the
   * counter that drives the backoff must move on each attempt. Counting at
   * schedule time instead would leave it pinned at zero for a hidden tab,
   * which defers rather than schedules. */
  const attemptReconnect = (): void => {
    priorFailures += 1;
    open();
  };

  const scheduleReconnect = (): void => {
    if (closed || waitingToReconnect()) return;
    if (document.hidden) { deferredWhileHidden = true; return; }
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      attemptReconnect();
    }, reconnectDelayMs(priorFailures));
  };

  /** Short-circuit a wait on fresh evidence the link may be back. Does
   * nothing with a socket open or an attempt in flight: there is nothing to
   * hurry, a second WebSocket would leak the first, and it is this guard that
   * lets `onclose` trust that the socket closing is the current one. */
  const reconnectNow = (): void => {
    if (closed || !waitingToReconnect()) return;
    clearReconnectTimer();
    deferredWhileHidden = false;
    attemptReconnect();
  };

  /** `online` is not user action: a flapping access point or a wifi/cellular
   * handover fires it repeatedly, and each event would otherwise buy an
   * immediate attempt -- the hidden-tab hammering this policy exists to stop.
   * So honour it only once the delay the schedule would have used has passed
   * since the last attempt; otherwise leave the wait as it stands (a pending
   * timer, or the hidden deferral, whichever is holding it).
   * `visibilitychange` needs no such guard: it is bounded by the user. */
  const onNetworkOnline = (): void => {
    if (Date.now() - lastAttemptAt < reconnectDelayMs(priorFailures)) return;
    reconnectNow();
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
    lastAttemptAt = Date.now();
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
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      opts.onStatus(false);
      scheduleReconnect();
    };
  };

  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", onNetworkOnline);
  open();

  return {
    close() {
      closed = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", onNetworkOnline);
      if (pingTimer) clearInterval(pingTimer);
      clearReconnectTimer();
      ws?.close();
    },
  };
}
