// pattern: Imperative Shell
import { useRef, useState } from "react";
import { apiFetch } from "../api/client";
import type { UpdateTextOp } from "../api/ops";
import type { BlockGroup, GroupsPayload } from "../api/payloads";
import { linkUnlinkedReference } from "../grammar/linkReference";
import { tokenizeBlock } from "../grammar/tokenize";
import { sha256Hex } from "../replica/sha256";
import type { WriteTicket } from "../sync/opQueue";
import { useSync } from "../sync/SyncProvider";
import { InlineSegments } from "./InlineSegments";
import { PageLink } from "./PageLink";
import { mergeGroups } from "./groups";

const PAGE_SIZE = 20;

type ItemStatus =
  | { state: "pending" }
  | { state: "error"; message: string };

export function UnlinkedSection({ title, onLinked }: {
  title: string;
  onLinked?: () => void;
}) {
  const sync = useSync();
  const [open, setOpen] = useState(false);
  const [groups, setGroups] = useState<BlockGroup[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [itemStatus, setItemStatus] = useState<Record<string, ItemStatus>>({});
  const [hiddenUids, setHiddenUids] = useState<ReadonlySet<string>>(new Set());
  const inFlight = useRef(new Set<string>());

  const setStatus = (uid: string, status?: ItemStatus) => {
    setItemStatus((current) => {
      const next = { ...current };
      if (status) next[uid] = status;
      else delete next[uid];
      return next;
    });
  };

  const load = async (from: number) => {
    setLoading(true);
    setError(null);
    try {
      const p = await apiFetch<GroupsPayload>(
        `/api/unlinked?title=${encodeURIComponent(title)}&limit=${PAGE_SIZE}&offset=${from}`);
      setGroups((g) => mergeGroups(g, p.groups));
      setTotal(p.total);
      // /api/unlinked paginates by blocks: advance by items received.
      setOffset(from + p.groups.reduce((n, gr) => n + gr.items.length, 0));
    } catch (e: unknown) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const linkItem = async (group: BlockGroup, item: BlockGroup["items"][number]) => {
    if (!sync.canEdit || inFlight.current.has(item.uid)) return;
    const transformed = linkUnlinkedReference(item.text, title);
    if (transformed.status === "no-safe-match") {
      setStatus(item.uid, { state: "error", message: "No linkable occurrence found." });
      return;
    }

    inFlight.current.add(item.uid);
    setStatus(item.uid, { state: "pending" });
    const op: UpdateTextOp = {
      op: "update_text",
      uid: item.uid,
      text: transformed.text,
      base_text_hash: sha256Hex(item.text),
    };

    let ticket: WriteTicket;
    try {
      ticket = sync.enqueue([op], ["page", group.page_title]);
    } catch (queueError: unknown) {
      inFlight.current.delete(item.uid);
      setStatus(item.uid, { state: "error", message: String(queueError) });
      return;
    }

    const settled = await ticket.settled;
    if (settled.status === "failed") {
      inFlight.current.delete(item.uid);
      setStatus(item.uid, { state: "error", message: String(settled.error) });
      return;
    }
    setHiddenUids((current) => new Set(current).add(item.uid));

    const delivered = await ticket.delivered;
    inFlight.current.delete(item.uid);
    if (delivered.status === "failed") {
      setHiddenUids((current) => {
        const next = new Set(current);
        next.delete(item.uid);
        return next;
      });
      setStatus(item.uid, { state: "error", message: String(delivered.error) });
      return;
    }
    setStatus(item.uid);
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
      items: group.items.filter((item) => !hiddenUids.has(item.uid)),
    }))
    .filter((group) => group.items.length > 0);
  const visibleTotal = total === null ? null : Math.max(0, total - hiddenUids.size);

  return (
    <section className="unlinked">
      <h2 className="section-header collapsible" onClick={toggle}>
        <span className={"chevron" + (open ? "" : " closed")}>▸</span>
        {" "}Unlinked references{visibleTotal !== null ? ` (${visibleTotal})` : ""}
      </h2>
      {open && (
        <>
          {visibleGroups.map((g) => (
            <div className="backlink-group" key={g.page_id}>
              <h3 className="group-title"><PageLink title={g.page_title} tag={false} /></h3>
              {g.items.map((item) => {
                const status = itemStatus[item.uid];
                return (
                  <div className="backlink-item" key={item.uid}>
                    <div className="unlinked-link-row">
                      <div className="backlink-text">
                        <InlineSegments segments={tokenizeBlock(item.text)} />
                      </div>
                      <button
                        className="reference-link-button btn-secondary"
                        disabled={!sync.canEdit || status?.state === "pending"}
                        title={!sync.canEdit ? sync.readOnlyReason : undefined}
                        onClick={() => void linkItem(g, item)}
                      >
                        {status?.state === "pending" ? "Linking…" : "Link"}
                      </button>
                    </div>
                    {status?.state === "error" && (
                      <p className="error unlinked-item-error">{status.message}</p>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {error && <p className="error">{error}</p>}
          {total !== null && offset < total && (
            <button className="show-more btn-secondary" onClick={() => void load(offset)} disabled={loading}>
              {loading ? "Loading…" : "Show more"}
            </button>
          )}
        </>
      )}
    </section>
  );
}
