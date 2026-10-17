// pattern: Functional Core
// The sync wire boundary: an HTTP body arrives as `unknown` and is read as
// the type the server's contract states. Nothing here checks the shape at
// runtime; the generated contract (src/api/types.d.ts) is what carries the
// brands the server minted, so this is the one place they are trusted.
import type { OpsAck } from "../api/payloads";
import type { Changes, Snapshot } from "../replica/apply";

export const snapshotOfWire = (body: unknown): Snapshot => body as Snapshot;

export const changesOfWire = (body: unknown): Changes => body as Changes;

export const opsAckOfWire = (body: unknown): OpsAck => body as OpsAck;
