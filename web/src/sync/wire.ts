// pattern: Functional Core
// The sync wire boundary: an HTTP body or WebSocket frame arrives untyped and
// is read as the type the server's contract states. Nothing here checks a
// body's shape at runtime; the generated contract (src/api/types.d.ts)
// carries the brands the server minted, so this is the one place they are
// trusted. A tombstone's text entity id and a WS frame's kind are the two
// places a value is told apart, so those are decoded.
import type {
  BlockUid, ClientId, PageId, SidebarEntryId, SyncSeq,
} from "../api/brands";
import type { BlockOp } from "../api/ops";
import type { OpsAck } from "../api/payloads";
import type { Changes, Snapshot, SyncTombstone } from "../replica/apply";

export const snapshotOfWire = (body: unknown): Snapshot => body as Snapshot;

export const changesOfWire = (body: unknown): Changes => body as Changes;

export const opsAckOfWire = (body: unknown): OpsAck => body as OpsAck;

/** A tombstone's entity id read as the id its kind names. */
export type TombstoneId =
  | { kind: "block"; id: BlockUid }
  | { kind: "page"; id: PageId }
  | { kind: "sidebar"; id: SidebarEntryId };

/** The journal stores every entity id as one TEXT field whatever the kind.
 * A kind this build doesn't know (an older replica meeting a kind a newer
 * server added) reads as null. */
export function tombstoneIdOfWire(tomb: SyncTombstone): TombstoneId | null {
  switch (tomb.kind) {
    case "block": return { kind: "block", id: tomb.entity_id as BlockUid };
    case "page": return { kind: "page", id: Number(tomb.entity_id) as PageId };
    case "sidebar":
      return { kind: "sidebar", id: Number(tomb.entity_id) as SidebarEntryId };
    default: {
      // Never reached for a kind this build knows; a kind added to the
      // contract fails to compile here until it is handled above.
      const unhandled: never = tomb.kind;
      void unhandled;
      return null;
    }
  }
}

export interface WsBatch {
  client_id: ClientId;
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
  seq: SyncSeq;
  force?: boolean;
  generation?: string;
}

export type WsFrame =
  | { kind: "seq"; frame: WsSeq }
  | { kind: "batch"; frame: WsBatch };

/** Narrows one WebSocket text frame: a `seq` nudge, a batch (anything with
 * an `ops` array), or null for any other JSON. Text that is not JSON throws,
 * as JSON.parse does. */
export function wsFrameOfWire(data: string): WsFrame | null {
  const msg = JSON.parse(data) as unknown;
  if (!msg) return null;
  if ((msg as WsSeq).type === "seq") return { kind: "seq", frame: msg as WsSeq };
  if (!Array.isArray((msg as WsBatch).ops)) return null;
  return { kind: "batch", frame: msg as WsBatch };
}
