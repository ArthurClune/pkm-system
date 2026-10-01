// pattern: Functional Core
// The missing-page policy every outline-loading surface shares: given a page
// read that failed, is there a stand-in payload to display instead?
import type { CanonicalTitle, PageId } from "../api/brands";
import type { PagePayload } from "../api/payloads";
import { dailyTitle } from "../replica/daily";

/** No real page has a negative id outside an offline replica, so this
 * stand-in payload's id can never collide with one actually fetched. */
const MISSING_PAGE_ID = -1 as PageId;

/** Decides what a failed page read means. `status` is the HTTP status the
 * read failed with, or null when the failure was not an HTTP error at all
 * (transport, offline). A returned payload is delivered exactly as a
 * successful response would be; null leaves the read failed. `Title` is
 * the form of title the read was made with: a policy that puts it in the
 * stand-in payload's `page.title` needs it canonical. */
export type MissingPagePolicy<Title extends string = string> = (
  title: Title,
  status: number | null,
) => PagePayload | null;

const emptyPagePayload = (title: CanonicalTitle): PagePayload => ({
  page: { id: MISSING_PAGE_ID, title, created_at: 0, updated_at: 0 },
  blocks: [],
  backlinks: { groups: [], total_pages: 0, offset: 0, limit: 20 },
  block_ref_texts: {},
  block_ref_counts: {},
});

/** A non-today daily page 404s if nobody has written to it yet or it was
 * pruned empty (server: GET /api/page auto-creates only today's daily).
 * It is an empty editable page, not an error, in every surface
 * that displays it — the first edit lazily creates the row via
 * CreateOp's get_or_create. Any other missing page stays an error. */
export const substituteMissingDaily: MissingPagePolicy = (title, status) => {
  const daily = status === 404 ? dailyTitle(title) : null;
  return daily === null ? null : emptyPagePayload(daily);
};

/** The same rule for a title the journal already knows is a day: /api/journal
 * only ever names dailies, so the date check is redundant there and a 404 is
 * an empty day whatever the title looks like. */
export const substituteMissingDay: MissingPagePolicy<CanonicalTitle> = (
  title, status) =>
  status === 404 ? emptyPagePayload(title) : null;
