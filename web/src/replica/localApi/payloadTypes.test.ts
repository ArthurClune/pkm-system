// Compile-time drift probes for the offline gateway (pkm-60bf). The shim's
// whole promise is that an offline response is the same JSON the server
// would have sent, but its builders used to return `unknown`, so a field
// could be renamed, dropped or mistyped on one side only and nothing
// complained until a user hit it offline. Each probe below asserts a
// builder's return type is EXACTLY the generated payload type; `pnpm
// typecheck` is what runs them.
//
// shim_parity.json (parity.test.ts) checks recorded VALUES for a handful of
// requests; these probes check the static SHAPE of every builder, including
// branches no fixture exercises.
//
// What these probes do NOT cover: the return type only bites if the payload
// is BUILT in checked code. `ReplicaDb.select<T>` asserts its type argument,
// so a builder that fetched rows as `select<PageMeta>` and returned them
// would satisfy its probe while checking nothing. The builders map rows into
// checked object literals for exactly that reason -- see the note on PageRow
// in pages.ts. Verified by renaming a field in each of the five generated
// row models and confirming all five map sites fail to compile.
import { expect, it } from "vitest";
import type { BlockRefsPayload, CurrentWorkPayload, GroupsPayload,
              JournalPayload, PageMeta, PagePayload, SearchPayload,
              SidebarNavPayload, TitlesPayload } from "../../api/payloads";
import { journalPayload } from "./journal";
import { currentWorkPayload, fetchPage, pagePayload, unlinked } from "./pages";
import { blockRefsPayload, sidebarPayload, titlesPayload } from "./router";
import { searchPayload } from "./search";

/** Mutual assignability: a builder widened back to `unknown` fails the first
 * arm, and one that quietly drops a field fails the second. */
type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

it("types every offline response builder with its generated payload", () => {
  const probes: [
    Exact<ReturnType<typeof pagePayload>, PagePayload | null>,
    Exact<ReturnType<typeof unlinked>, GroupsPayload | null>,
    Exact<ReturnType<typeof journalPayload>, JournalPayload | null>,
    Exact<ReturnType<typeof currentWorkPayload>, CurrentWorkPayload>,
    Exact<ReturnType<typeof searchPayload>, SearchPayload>,
    Exact<ReturnType<typeof titlesPayload>, TitlesPayload>,
    Exact<ReturnType<typeof sidebarPayload>, SidebarNavPayload>,
    Exact<ReturnType<typeof blockRefsPayload>, BlockRefsPayload>,
    Exact<ReturnType<typeof fetchPage>, PageMeta | null>,
  ] = [true, true, true, true, true, true, true, true, true];
  expect(probes).toHaveLength(9);
});
