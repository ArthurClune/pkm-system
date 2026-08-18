// pattern: Imperative Shell
// The one blocks-only page read behind every authoritative loader a surface
// registers on an outline session. It exists so the missing-page decision is
// made in exactly one place — missingPage.ts states the policy, this fetches
// and applies it — because these loaders, not the view-level guards, are what
// repair epochs and post-settlement catch-up reads actually hit.
import { ApiError } from "../api/client";
import { apiGet } from "../api/typedClient";
import type { BlockNode } from "../api/payloads";
import type { MissingPagePolicy } from "./missingPage";

/** The HTTP status a read failed with, or null when the failure was not an
 * HTTP error at all (transport, offline). */
export const statusOf = (error: unknown): number | null =>
  error instanceof ApiError ? error.status : null;

export async function loadOutlineBlocks(
  title: string,
  missingPage: MissingPagePolicy,
): Promise<BlockNode[]> {
  try {
    const page = await apiGet("/api/page/{title}", { path: { title } });
    return page.blocks;
  } catch (e: unknown) {
    const substitute = missingPage(title, statusOf(e));
    if (substitute) return substitute.blocks;
    throw e;
  }
}
