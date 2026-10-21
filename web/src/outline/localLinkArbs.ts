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
  "}", ":", "::", "<", ">", "\\", "|", "@", ";", "\t", "\r", "\u0001",
  "\u{1F4C4}", "\u{1F4C4}", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
  "\u00E9", "e\u0301", "\u00FC", "u\u0308", "\u00DF", "\u0130", "i\u0307",
  "\u4E2D\u6587", ".pdf", "[draft]", "(Public)", "[[x]]", "](", "](x)",
  "[a](b)",
];

// Names never hold "/" or NUL (the file system forbids both) and are never
// empty. A newline is a separate piece so a test can leave it out.
export const NEWLINE_PIECE = "\n";

export function hostileNameWith(
  pieces: readonly string[] = [...PIECES, NEWLINE_PIECE],
): fc.Arbitrary<string> {
  return fc
    .array(
      fc.oneof(
        { weight: 5, arbitrary: fc.constantFrom(...pieces) },
        fc.string({ maxLength: 3 }),
      ),
      { minLength: 1, maxLength: 6 },
    )
    .map((parts) => parts.join("").replace(/[/\0\n]/g, (c) =>
      pieces.includes(c) ? c : "_"))
    .filter((s) => s !== "");
}

export const hostileName = hostileNameWith();
export const hostileNameNoNewline = hostileNameWith(PIECES);
