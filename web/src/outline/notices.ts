// pattern: Functional Core
// The outline's dismissible notices: one slot per kind, each holding the
// latest text or null. Setters hand back the same slots object when nothing
// changed, so a functional useState update on an unchanged slot bails out
// instead of committing every mounted outline again.

export type NoticeKind =
  /** The last /upload, paste or drag-drop failure. Cleared when the next
   * upload starts. */
  | "upload"
  /** Outcome of the last /goodlinks pick: "Saved to Goodlinks" or a failure
   * (see outline/goodlinks.ts). Cleared when the next pick starts. */
  | "goodlinks"
  /** Why the last edit was refused: a command past the depth cap or a text
   * limit, a keystroke the editor refused, a refused draft, or an undo or
   * redo that could not apply. One slot: the latest refusal is the one to
   * tell. The next command that applies clears it. */
  | "edit"
  /** The last refused clipboard copy, with the text to copy by hand. Cleared
   * when the next copy starts. */
  | "copy";

export interface OutlineNotice {
  readonly kind: NoticeKind;
  readonly tone: "error" | "status";
  readonly text: string;
}

export type NoticeSlots = Readonly<Record<NoticeKind, string | null>>;

export const NO_NOTICES: NoticeSlots = { upload: null, goodlinks: null,
                                         edit: null, copy: null };

const ORDER: readonly NoticeKind[] = ["upload", "goodlinks", "edit",
                                    "copy"];

/** The same object when the slot already holds `text`. */
export function withNotice(slots: NoticeSlots, kind: NoticeKind,
                           text: string | null): NoticeSlots {
  return slots[kind] === text ? slots : { ...slots, [kind]: text };
}

/** Clears `kind` only while it still holds `text`. */
export function clearNoticeIf(slots: NoticeSlots, kind: NoticeKind,
                              text: string): NoticeSlots {
  return slots[kind] === text ? withNotice(slots, kind, null) : slots;
}

/** The copy notice's text; the copied text is never truncated. */
export function copyFailedNotice(text: string): string {
  return `Copying failed. Select and copy it: ${text}`;
}

/** In render order: upload, goodlinks, edit, copy. */
export function noticeList(slots: NoticeSlots): readonly OutlineNotice[] {
  const list: OutlineNotice[] = [];
  for (const kind of ORDER) {
    const text = slots[kind];
    if (text === null) continue;
    list.push({ kind, tone: kind === "upload" || kind === "copy" ? "error"
                                                      : "status", text });
  }
  return list;
}

export function noticeOf(notices: readonly OutlineNotice[],
                         kind: NoticeKind): string | null {
  return notices.find((n) => n.kind === kind)?.text ?? null;
}
