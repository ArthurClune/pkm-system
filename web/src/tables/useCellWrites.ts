// pattern: Imperative Shell
// A query table's cell writes: each goes through the op queue scoped to the
// record's page, shows at once in an open copy of that page, patches the
// record once the queue has it, and leaves a notice whose Undo sends the
// inverse captured when the write was made.
//
// A press on a notice's Undo commits an open cell first (the editor's
// capture mousedown), which makes a new write and a new notice. Swapping the
// notice under the pointer would lose the click, or land it on the new
// notice's Undo, so a notice made during that press waits until the press
// ends.
//
// DataTable may commit an open cell after this hook's cleanup has run (its
// unmount commit), so `write` uses nothing the cleanup tears down.
import { useCallback, useEffect, useRef, useState } from "react";
import type { BlockOp } from "../api/ops";
import type { QueryRecordModel } from "../api/payloads";
import { textLimitNotice, textLimitViolation } from "../grammar/textLimits";
import { peekOutlineSession } from "../outline/outlineSessions";
import type { WriteTicket } from "../sync/opQueue";
import { useSyncActions } from "../sync/SyncProvider";
import { newUid } from "../uid";
import {
  inverseCellWrite, patchRecord, writeMessage, type QueryColumn,
} from "./queryView";
import { planCellWrite } from "./records";

export interface CellNotice {
  id: number;
  message: string;
  undo?: () => void;
}

type Patch = (recordKey: string,
              fn: (r: QueryRecordModel) => QueryRecordModel) => void;

export function useCellWrites(patch: Patch) {
  const sync = useSyncActions();
  const [notice, setNotice] = useState<CellNotice | null>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const press = useRef<{ on: boolean; held: CellNotice | null | undefined }>(
    { on: false, held: undefined });
  const ids = useRef(0);

  useEffect(() => {
    // Window capture runs before the cell editor's document capture.
    const down = (e: MouseEvent) => {
      press.current.on = noticeRef.current?.contains(e.target as Node) ?? false;
    };
    // After the click this press makes, which follows mouseup in its task.
    const up = () => {
      if (!press.current.on) return;
      press.current.on = false;
      setTimeout(() => {
        const held = press.current.held;
        press.current.held = undefined;
        if (held !== undefined) setNotice(held);
      }, 0);
    };
    window.addEventListener("mousedown", down, true);
    window.addEventListener("mouseup", up, true);
    return () => {
      window.removeEventListener("mousedown", down, true);
      window.removeEventListener("mouseup", up, true);
    };
  }, []);

  const show = useCallback((n: CellNotice | null) => {
    if (press.current.on) press.current.held = n;
    else setNotice(n);
  }, []);

  const send = useCallback((r: QueryRecordModel, key: string,
                            ops: BlockOp[]): boolean => {
    for (const op of ops) {
      if (op.op !== "update_text" && op.op !== "create") continue;
      const over = textLimitViolation(op.text);
      if (over !== null) {
        show({ id: ++ids.current, message: textLimitNotice(over) });
        return false;
      }
    }
    let ticket: WriteTicket;
    try {
      ticket = sync.enqueue(ops, ["page", r.page_title]);
    } catch (e: unknown) {
      show({ id: ++ids.current, message: String(e) });
      return false;
    }
    const handle = peekOutlineSession(r.page_title);
    if (handle) {
      try {
        handle.applyLocal(ticket, ops);
      } finally {
        handle.release();
      }
    }
    void ticket.settled.then((outcome) => {
      if (outcome.status === "persisted") {
        patch(r.key, (cur) => patchRecord(cur, key, ops));
      } else {
        show({ id: ++ids.current,
               message: `The write to ${r.page_title} failed: ${String(outcome.error)}` });
      }
    });
    return true;
  }, [sync, patch, show]);

  const write = useCallback((r: QueryRecordModel, column: QueryColumn,
                             value: string) => {
    const ops = planCellWrite(r, column.key, column.label, value, newUid);
    if (ops.length === 0) return;
    const inverse = inverseCellWrite(r, column.key, ops);
    if (!send(r, column.key, ops)) return;
    const id = ++ids.current;
    show({
      id, message: writeMessage(column.label, value, r.page_title),
      undo: () => {
        setNotice((cur) => (cur?.id === id ? null : cur));
        send(r, column.key, inverse);
      },
    });
  }, [send, show]);

  const dismiss = useCallback(() => setNotice(null), []);

  return { write, notice, dismiss, noticeRef };
}
