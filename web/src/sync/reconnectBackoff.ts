// pattern: Functional Core
// The websocket reconnect schedule. Split out of socket.ts because "how long
// until the next attempt" is the whole policy and is worth reading, and
// testing, without a WebSocket in the picture (pkm-d6i6). The old fixed 2 s
// loop retried a dead link 30 times a minute forever, which keeps a mobile
// radio out of low power for as long as the tab is open.

export const RECONNECT_BASE_MS = 2000;
export const RECONNECT_MAX_MS = 30_000;

/** Delay before the attempt that follows `priorFailures` consecutive failed
 * connects: 2 s, 4 s, 8 s, 16 s, then 30 s forever. `priorFailures` is 0 for
 * the first retry after a drop, so a link that comes straight back still
 * reconnects in the original 2 s; the counter resets only once a connection
 * proves itself (a frame received, or staying open past socket.ts's
 * STABLE_MS), not on the bare handshake, so a server that accepts and
 * immediately closes still backs off, and the ceiling is only ever reached
 * by a link that is genuinely gone (pkm-uue4). */
export function reconnectDelayMs(priorFailures: number): number {
  return Math.min(RECONNECT_BASE_MS * 2 ** priorFailures, RECONNECT_MAX_MS);
}
