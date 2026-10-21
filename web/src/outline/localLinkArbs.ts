// pattern: Functional Core
// Generators for the local-docs and GoodLinks link property tests: file
// names as the iCloud folder really has them (decomposed, punctuation-heavy,
// emoji, control characters) and the hrefs the server builds for them.
import fc from "fast-check";

// Python's urllib.parse.quote(path, safe="/"): everything but letters,
// digits, `_.-~` and `/` is percent-encoded as UTF-8.
export function localHref(path: string): string {
  const encoded = path
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join("/");
  return `/api/local/${encoded}`;
}

const PIECES = [
  "a", "b", "Z", "x y", " ", "  ", ".", "..", "_", "-", "~", "%", "%41", "#",
  "?", "&", "+", "=", "[", "]", "(", ")", "'", '"', "`", "*", "!", "$", "{",
  "}", ":", "::", "<", ">", "|", "@", ";",
  "\u{1F4C4}", "\u{1F4C4}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
  "\u00E9", "e\u0301", "\u00FC", "u\u0308", "\u00DF", "\u0130", "i\u0307",
  "\u4E2D\u6587", ".pdf", "[draft]", "(Public)", "[[x]]", "](", "](x)",
  "[a](b)",
];

// Names are exactly what the server lists: clean_relative in
// server/src/pkm/local_docs.py rejects control characters and backslashes, so
// neither is drawn; "/" and NUL cannot occur in a file name; names are never
// empty; the server hides dot-names, so none starts with ".".
const ILLEGAL = /[/\\\u0000-\u001f\u007f-\u009f]/g;

export function hostileNameWith(
  pieces: readonly string[] = PIECES,
): fc.Arbitrary<string> {
  return fc
    .array(
      fc.oneof(
        { weight: 5, arbitrary: fc.constantFrom(...pieces) },
        fc.string({ maxLength: 3 }),
      ),
      { minLength: 1, maxLength: 6 },
    )
    .map((parts) => parts.join("").replace(ILLEGAL, "_").replace(/^\./, "_") || "a");
}

export const hostileName = hostileNameWith();
