// pattern: Imperative Shell

// "reason" for `// brand: untrusted -- <why>`, "bare" for the marker with no
// reason, null for any other comment.
function optOutKind(comment) {
  if (/^\s*brand: untrusted -- \S/.test(comment.value)) return "reason";
  if (/^\s*brand: untrusted\b/.test(comment.value)) return "bare";
  return null;
}

// An opt-out covers exactly one site: the leftmost site (by line, then
// column) that needs one, on the comment's own line or on the line below a
// comment standing alone. A second site on the line is reported, and so is
// an opt-out that covers none, as the server's `brand-opt-out-unused` does.
// The two brand rules that read opt-outs (`name-carries-brand`,
// `no-brand-assertion`) hand their sites to one ledger per file, which pairs
// them once every rule has finished the traversal, so the order the rules
// walk in cannot change who is covered. A site is `{ line, column, resolve }`
// and `resolve(kind)` reports it given the kind of the comment that covers it
// ("reason", "bare") or null.
const ledgers = new WeakMap();

export function joinLedger(context) {
  const { sourceCode } = context;
  let ledger = ledgers.get(sourceCode);
  if (!ledger) {
    ledger = {
      rules: 0,
      sites: [],
      reportUnused: (comment) =>
        context.report({ loc: comment.loc, messageId: "optOutUnused" }),
    };
    ledgers.set(sourceCode, ledger);
  }
  ledger.rules++;
  return {
    site(node, resolve) {
      const { line, column } = node.loc.start;
      ledger.sites.push({ line, column, resolve });
    },
    exit() {
      if (--ledger.rules > 0) return;
      ledgers.delete(sourceCode);
      settleOptOuts(sourceCode, ledger);
    },
  };
}

function settleOptOuts(sourceCode, ledger) {
  const standsAlone = (c) =>
    sourceCode.lines[c.loc.start.line - 1].slice(0, c.loc.start.column)
      .trim() === "";
  const comments = sourceCode.getAllComments()
    .map((comment) => ({ comment, kind: optOutKind(comment) }))
    .filter((o) => o.kind !== null);
  const claimed = new Set();
  const sites = [...ledger.sites].sort(
    (a, b) => a.line - b.line || a.column - b.column);
  for (const site of sites) {
    const cover = comments.find(({ comment: c }) => !claimed.has(c)
      && (c.loc.end.line === site.line
        || c.loc.end.line === site.line - 1 && standsAlone(c)));
    if (cover) claimed.add(cover.comment);
    site.resolve(cover?.kind ?? null);
  }
  for (const { comment } of comments) {
    if (!claimed.has(comment)) ledger.reportUnused(comment);
  }
}

export const OPT_OUT_UNUSED =
  "this `// brand: untrusted -- <reason>` covers no site: an opt-out covers "
  + "the leftmost name or assertion on its line, or on the line below it "
  + "when it stands alone, that needs one, so remove it, or give each "
  + "further site its own line and its own opt-out";