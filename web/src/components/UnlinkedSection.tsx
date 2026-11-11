// pattern: Imperative Shell
import { useState } from "react";
import { apiGet } from "../api/typedClient";
import type { BlockUid, CanonicalTitle } from "../api/brands";
import type { UpdateTextOp } from "../api/ops";
import type { BlockGroup } from "../api/payloads";
import { linkUnlinkedReference } from "../grammar/linkReference";
import { textLimitNotice, textLimitViolation } from "../grammar/textLimits";
import { tokenizeBlock } from "../grammar/tokenize";
import { sha256Hex } from "../replica/sha256";
import type { WriteTicket } from "../sync/opQueue";
import { useSyncActions, useSyncEditability } from "../sync/SyncProvider";
import { useReducerRef } from "../useReducerRef";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";
import { mergeGroups } from "./groups";
import {
  canLink, isListed, nextOffset as nextOffsetOf, settledCount, withStatus,
  withoutDelivered, type LinkStatus, type LinkStatuses,
} from "./unlinkedStatus";

const PAGE_SIZE = 20;

const moveStatus = (statuses: LinkStatuses,
                    { uid, status }: { uid: BlockUid; status: LinkStatus }) =>
  withStatus(statuses, uid, status);
const noStatuses = (): LinkStatuses => new Map();

export function UnlinkedSection({ title, onLinked }: {
  title: CanonicalTitle;
  onLinked?: () => void;
}) {
  const sync = useSyncActions();
  const { canEdit, readOnlyReason } = useSyncEditability();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<BlockGroup[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Read through current() in the click handler, so a second click before
  // the re-render sees the first one's "pending".
  const { state: statuses, current, dispatch } =
    useReducerRef(moveStatus, noStatuses);
  const setStatus = (uid: BlockUid, status: LinkStatus) =>
    dispatch({ uid, status });

  const load = async (from: number) => {
    setLoading(true);
    setError(null);
    try {
      const p = await apiGet("/api/unlinked", {
        query: { title, limit: PAGE_SIZE, offset: from },
      });
      const fresh = withoutDelivered(p.groups, current());
      setGroups((g) => mergeGroups(g, fresh));
      setTotal(p.total);
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const linkItem = async (group: BlockGroup, item: BlockGroup["items"][number]) => {
    if (!canEdit || !canLink(current().get(item.uid))) return;
    const transformed = linkUnlinkedReference(item.text, title);
    if (transformed.status === "no-safe-match") {
      setStatus(item.uid, { error: "No linkable occurrence found." });
      return;
    }
    // The server would refuse the batch whole; never queue it.
    const overLimit = textLimitViolation(transformed.text);
    if (overLimit !== null) {
      setStatus(item.uid, { error: textLimitNotice(overLimit) });
      return;
    }

    setStatus(item.uid, "pending");
    const op: UpdateTextOp = {
      op: "update_text",
      uid: item.uid,
      text: transformed.text,
      base_text_hash: sha256Hex(item.text),
      page_title: group.page_title,
    };

    let ticket: WriteTicket;
    try {
      ticket = sync.enqueue([op], ["page", group.page_title]);
    } catch (queueError: unknown) {
      setStatus(item.uid, { error: String(queueError) });
      return;
    }

    const settled = await ticket.settled;
    if (settled.status === "failed") {
      setStatus(item.uid, { error: String(settled.error) });
      return;
    }
    setStatus(item.uid, "settled");

    const delivered = await ticket.delivered;
    if (delivered.status === "failed") {
      setStatus(item.uid, { error: String(delivered.error) });
      return;
    }
    // The server's list has lost this block, shifting every later one left
    // by one, so it leaves the loaded list and the total rather than staying
    // hidden: the next Show more offset counts only blocks still listed.
    const now = setStatus(item.uid, "delivered");
    setGroups((current) => withoutDelivered(current, now));
    setTotal((current) => current === null ? null : Math.max(0, current - 1));
    onLinked?.();
  };

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next && total === null) void load(0); // lazy: fetch on first open only
  };

  const visibleGroups = groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => isListed(statuses.get(item.uid))),
    }))
    .filter((group) => group.items.length > 0);
  const visibleTotal = total === null
    ? null : Math.max(0, total - settledCount(statuses));
  const loadedCount = groups.reduce((n, g) => n + g.items.length, 0);
  const nextOffset = nextOffsetOf(loadedCount, statuses);

  return (
    <section className="unlinked">
      {/* The toggle is a real button inside the heading: an onClick
        * on the <h2> was unreachable from the keyboard and announced no
        * state. */}
      <h2 className="section-header collapsible">
        <button type="button" className="section-toggle" aria-expanded={open}
                onClick={toggle}>
          <span className={"chevron" + (open ? "" : " closed")}
                aria-hidden="true">▸</span>
          {" "}Unlinked references{visibleTotal !== null ? ` (${visibleTotal})` : ""}
        </button>
      </h2>
      {open && (
        <>
          {visibleGroups.map((g) => (
            <div className="backlink-group" key={g.page_id}>
              <h3 className="group-title"><PageLink title={g.page_title} tag={false} /></h3>
              {g.items.map((item) => {
                const status = statuses.get(item.uid);
                return (
                  <div className="backlink-item" key={item.uid}>
                    <div className="unlinked-link-row">
                      <div className="backlink-text">
                        <InlineSegments segments={tokenizeBlock(item.text)} />
                      </div>
                      <button
                        className="reference-link-button btn-secondary"
                        disabled={!canEdit || status === "pending"}
                        title={!canEdit ? readOnlyReason : undefined}
                        onClick={() => void linkItem(g, item)}
                      >
                        {status === "pending" ? "Linking…" : "Link"}
                      </button>
                    </div>
                    {typeof status === "object" && (
                      <p className="error unlinked-item-error">{status.error}</p>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {error && <p className="error">{error}</p>}
          {total !== null && loadedCount < total && (
            <button className="show-more btn-secondary" onClick={() => void load(nextOffset)}
                    disabled={loading}>
              {loading ? "Loading…" : "Show more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
