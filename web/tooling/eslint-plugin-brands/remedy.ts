// pattern: Imperative Shell
import { WEB_PREFIX, registry } from "./registry.ts";

// The brand-specific parser, where the web has one.
const MODULES_SHOWN = 3;
const PARSERS: Record<string, string> = {
  BlockUid: "parseBlockUid", SyncSeq: "parseSyncSeq",
};

export const webTestMints = registry.testMintSites
  .filter((p) => p.startsWith(WEB_PREFIX));

// "use uidOf or malformedUid from web/src/test-mint.ts": the checked
// helper a test mints these brands with, and the forger of a bad value where
// the brand has a shape. Null when a brand has no helper.
function testRemedy(brands: readonly string[]): string | null {
  const names: string[] = [];
  for (const b of brands) {
    const stem = registry.testHelpers[b];
    if (stem === undefined) return null;
    names.push(`${stem}Of`);
    const bad = registry.malformed[b];
    if (bad !== undefined) {
      names.push(`malformed${bad[0].toUpperCase()}${bad.slice(1)}`);
    }
  }
  return `use ${names.join(" or ")} from ${webTestMints.join(", ")}`;
}

// "parseBlockUid, or mint it in web/src/uid.ts" from the registry's web mint
// modules for these brands; in test code, the test helper.
export function remedy(brands: readonly string[], inTest: boolean): string {
  const forTest = inTest ? testRemedy(brands) : null;
  if (forTest !== null) return forTest;
  const parsers = brands.flatMap((b) => PARSERS[b] ?? []);
  const modules = [...new Set(brands.flatMap(
    (b) => (registry.mintSites[b] ?? []).filter((p) => p.startsWith("web/")),
  ))];
  const parts: string[] = [];
  if (parsers.length) parts.push(`parse it with ${parsers.join(", ")}`);
  if (modules.length) {
    const shown = modules.slice(0, MODULES_SHOWN).join(", ");
    const more = modules.length - MODULES_SHOWN;
    parts.push(`mint it in ${shown}${more > 0 ? ` and ${more} more` : ""}`);
  }
  // No web mint site: the value belongs to where it enters the app, not to a
  // new registry entry here.
  else parts.push("pass it in already branded: this brand has no web mint site");
  return parts.join(", or ");
}

// `BlockUid` or `BlockUid[]`, by whether the name is a plural.
export function brandText(name: string, wanted: readonly string[]): string {
  const text = wanted.join(" or ");
  return /(uids|ids)$/i.test(name) ? `${text}[]` : text;
}