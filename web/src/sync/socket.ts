// pattern: Imperative Shell
// /api/ws client: JSON batch dispatch, keepalive pings (the server ignores
// inbound frames), and reconnect-until-close() under one connectivity policy
// (pkm-d6i6): exponential backoff (reconnectBackoff.ts), no *scheduled*
// attempts while the tab is hidden, an immediate attempt when the tab becomes
// visible again, and one on `online` too -- but never sooner than the backoff
// the schedule would have used, since `online` can fire repeatedly. Neither
// visibility nor `online` is a hard gate: `online` still fires (and still
// attempts, rate-limited by lastAttemptAt) while hidden, so a background tab
// is not attempt-free, only unscheduled. A socket the OS freezes while
// backgrounded (iPadOS/Safari `freeze`) is handled by a resume heuristic: a
// tab hidden for RESUME_STALE_MS or more that comes back to an object still
// reporting OPEN gets that socket closed on the spot, so the normal
// onclose/scheduleReconnect path replaces it (pkm-uue4). The backoff counter
// itself resets only on proof the link is real -- the first frame received,
// or the socket staying open past STABLE_MS -- not on the handshake
// completing, so a server that accepts and then immediately closes still
// backs off instead of being hammered at the base interval (pkm-uue4). The
// old fixed 2 s loop retried a dead link 30 times a minute for as long as the
// tab was open, foreground or not, which is what keeps a mobile radio out of
// low power.
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
/** How long a socket must stay open, with no frame yet received, before it
 * counts as proof the link is real and the backoff counter resets (pkm-uue4).
 * Exported so tests can advance fake timers by exactly this much rather than
 * duplicating the constant. */
export const STABLE_MS = 5_000;
/** A tab hidden this long or more may have had its socket frozen by the OS
 * rather than closed; on resume such a socket still reports OPEN but may
 * never deliver another frame, so it is closed on the spot and left to the
 * normal reconnect path (pkm-uue4). */
export const RESUME_STALE_MS = 30_000;

export function connectSocket(opts: {
  onBatch: (batch: WsBatch) => void;
  onStatus: (connected: boolean) => void;
  onSeq?: (frame: WsSeq) => void;
}): SocketHandle {
  let closed = false;
  let ws: WebSocket | null = null;
  let pingTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // Armed on open, cleared (with priorFailures reset) on the socket's first
  // frame or on STABLE_MS elapsing, whichever is first; left pending on
  // onclose means the socket never proved itself, so the failure count
  // stands (pkm-uue4).
  let stableTimer: ReturnType<typeof setTimeout> | null = null;
  let priorFailures = 0;
  // A reconnect that is due but not scheduled, because the tab is hidden: no
  // timer runs while hidden, so the return to visibility is what starts it.
  let deferredWhileHidden = false;
  // When the last attempt was started, so a short-circuit can be held to the
  // same delay as the timer it replaces.
  let lastAttemptAt = 0;
  // When the tab last went hidden, so a return to visibility can tell a
  // short background dip from a stretch long enough that the OS may have
  // frozen the socket (pkm-uue4).
  let hiddenAt = 0;

  const clearReconnectTimer = (): void => {
    if (reconnectTimer !== null) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  const clearStableTimer = (): void => {
    if (stableTimer !== null) { clearTimeout(stableTimer); stableTimer = null; }
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
    if (!document.hidden) {
      // A socket that is still nominally OPEN after a long enough hidden
      // spell may be one the OS froze rather than one that is still live;
      // closing it here hands it to the ordinary onclose/scheduleReconnect
      // path instead of trusting a socket that may never call again
      // (pkm-uue4).
      if (
        ws !== null && ws.readyState === WebSocket.OPEN &&
        hiddenAt > 0 && Date.now() - hiddenAt >= RESUME_STALE_MS
      ) {
        ws.close();
      }
      hiddenAt = 0;
      reconnectNow();
      return;
    }
    hiddenAt = Date.now();
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
      opts.onStatus(true);
      pingTimer = setInterval(() => sock.send("ping"), PING_MS);
      // Proof of life by patience: nothing arrived yet, but if the socket is
      // still open this long from now it counts as real (pkm-uue4).
      stableTimer = setTimeout(() => { stableTimer = null; priorFailures = 0; }, STABLE_MS);
    };
    sock.onmessage = (ev: MessageEvent) => {
      // Proof of life by evidence: any frame at all is earlier proof than
      // STABLE_MS, so it wins the race (pkm-uue4).
      if (stableTimer !== null) { clearStableTimer(); priorFailures = 0; }
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
      // A stableTimer still pending means the socket died before proving
      // itself: leave priorFailures standing so the next attempt backs off
      // further (pkm-uue4).
      clearStableTimer();
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
      clearStableTimer();
      ws?.close();
    },
  };
}
