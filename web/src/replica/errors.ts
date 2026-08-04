// pattern: Functional Core
// The replica's error taxonomy, and what each kind implies about availability.
// Pure class definitions and predicates: no I/O, no transport. rpc.ts (the
// transport shell) imports these; nothing here imports rpc.ts, which is what
// keeps ReplicaUnavailableError's `extends` out of an import cycle.
//
// Why a taxonomy exists at all: "is the replica usable?" used to be re-derived
// by every consumer, most alarmingly by matching strings in an error message to
// decide whether the user's writes survived (pkm-q2jj). The worker owns the
// fact; these types are how it travels.

export interface ReplicaErrorFlags {
  /** The replica refused the OP ITSELF (unsupported title syntax), not the
   * storing of it. This is the ONLY replica failure that is terminal for an op:
   * the server would refuse it too, so retaining and retrying cannot help, and
   * it is the one case that still reaches onDesync. */
  rejected?: boolean;
}

/** There was a `quota` flag here too, meant to mark "local storage refused the
 * write for want of space" and to drive a read-only mode. NOTHING could ever
 * set it (pkm-avag): the app runs on sqlite-wasm's opfs-sahpool VFS, whose
 * `xWrite` catches the `QuotaExceededError` DOMException from
 * `SyncAccessHandle.write()`, stores it on the pool's private `$error` and
 * returns `SQLITE_IOERR` — so what reaches this module is a bare "disk I/O
 * error", indistinguishable from any other write failure. Storage exhaustion
 * is therefore handled the same way as every other failure to persist: the op
 * is retained in the fallback lane and delivered online. */
export class ReplicaError extends Error {
  readonly rejected: boolean;

  constructor(message: string, flags: ReplicaErrorFlags = {}) {
    super(message);
    this.name = "ReplicaError";
    this.rejected = flags.rejected === true;
  }
}

/** The worker's own openDb() failure, latched for the session. Only the worker
 * can raise this: it is the one party able to say "there is definitively no
 * database", as opposed to "I could not ask". */
export class ReplicaUnavailableError extends ReplicaError {
  constructor(message: string, flags: ReplicaErrorFlags = {}) {
    super(message, flags);
    this.name = "ReplicaUnavailableError";
  }
}

export type RpcLifecycleKind =
  | "worker-error"
  | "message-error"
  | "timeout"
  | "disposed";

export class RpcLifecycleError extends Error {
  readonly kind: RpcLifecycleKind;
  override readonly cause: unknown;

  constructor(kind: RpcLifecycleKind, message: string, cause?: unknown) {
    super(message);
    this.name = "RpcLifecycleError";
    this.kind = kind;
    this.cause = cause;
  }
}

/** The availability fact, at the two evidentiary levels its two consumers need.
 * Retaining an op needs only "this write did not persist locally"; lifting the
 * op queue's recovery barrier needs "there is positively no poison table to
 * read", because delivering past an unrepaired rejection is the ordering hazard
 * the barrier exists for (pkm-bjae).
 *
 * | value        | meaning                          | retain? | may lift barrier? |
 * | unusable     | openDb() failed: no database      | yes     | YES               |
 * | unreachable  | the RPC is broken: could not ask  | yes     | NO                |
 *
 * Only `unusable` ever crosses the wire (the worker reporting its own failed
 * open). `unreachable` is generated client-side, so the two levels come from
 * two different places and are combined here, never in the wire shape. */
export type ReplicaAvailability = "unusable" | "unreachable";

export function availabilityOf(error: unknown): ReplicaAvailability | null {
  if (error instanceof ReplicaUnavailableError) return "unusable";
  if (error instanceof RpcLifecycleError) return "unreachable";
  return null;
}

/** Whether this evidence is itself permanent for the session, and so may be
 * latched by a consumer. The worker latches a failed open until close(), and
 * createRpcClient latches its own terminal state for worker-error/
 * message-error/disposed — but NOT for a timeout, which rejects one request and
 * leaves the client usable. Retention does not need this distinction (every
 * level retains); latching a state does. */
export function isSessionFatal(error: unknown): boolean {
  if (error instanceof ReplicaUnavailableError) return true;
  return error instanceof RpcLifecycleError && error.kind !== "timeout";
}
