// pattern: Functional Core
// Generators for the upload-link property tests: the file names an upload
// can carry, the URL the server returns for them and the markdown
// assetMarkdown builds.
import fc from "fast-check";
import type { Sha256Hex } from "../api/brands";
import { parseSha256Hex } from "../replica/sha256";
import { hostileNameWith } from "../outline/localLinkArbs";
import { assetMarkdown } from "./assets";

// Names the route stores are safe_filename output, but rows written before
// that bound existed, and direct API clients, can carry backslashes and
// colons, so those are drawn too. "/" and control characters never occur:
// they cannot sit in a URL path segment or on one line.
const EXTRA = ["\\", "\\)", "\\]", ":", "((", "))", "(()", "[[", "]]", "] (", "( )"];

export const uploadNameArb: fc.Arbitrary<string> = fc
  .tuple(hostileNameWith(), fc.option(fc.constantFrom(...EXTRA), { nil: null }))
  .map(([name, extra]) => (extra === null ? name : `${name}${extra}`));

// Python's urllib.parse.quote(name, safe=""): only letters, digits and
// `_.-~` stay. Twin of assets_core.asset_url.
export function assetHref(sha: Sha256Hex, name: string): string {
  const encoded = encodeURIComponent(name).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `/assets/${sha}/${encoded}`;
}

export const KINDS = [
  { mime: "image/png", ext: ".png" },
  { mime: "application/pdf", ext: ".pdf" },
  { mime: "text/plain", ext: ".txt" },
] as const;

export interface UploadText {
  name: string;
  mime: string;
  sha: Sha256Hex;
  href: string;
  text: string;
}

export function uploadText(name: string, mime: string, sha: Sha256Hex): UploadText {
  const href = assetHref(sha, name);
  return { name, mime, sha, href, text: assetMarkdown({ filename: name, mime, url: href }) };
}

// Names old uploads carry raw in their URL and label, limited to the ones
// that ever rendered as a link: parens and brackets balanced, no leading
// "[", nothing a bare URL would end at.
const LEGACY_PIECES = [
  "a", "Z", "9", " ", "x y", "(Public)", "((a))", "(x)", "[draft]", "%",
  "%41", "&", "#", "+", "\\", ":", "'", "é", "é", "\u{1F4C4}",
  "中文", "-", "_", "~", ",", ";", "=", "@", "!", "$",
];

export const legacyNameArb: fc.Arbitrary<string> = fc
  .tuple(
    fc.array(fc.constantFrom(...LEGACY_PIECES), { maxLength: 6 }),
    fc.constantFrom("", ".pdf", ".PDF", ".png", ".txt"),
  )
  .map(([parts, ext]) => `x${parts.join("")}${ext}`);

export const shaArb: fc.Arbitrary<Sha256Hex> = fc
  .stringMatching(/^[0-9a-f]{64}$/)
  .map((hex) => {
    const sha = parseSha256Hex(hex);
    if (sha === null) throw new Error(`generated a bad digest: ${hex}`);
    return sha;
  });

export const uploadTextArb: fc.Arbitrary<UploadText> = fc
  .tuple(uploadNameArb, fc.constantFrom(...KINDS), fc.boolean(), shaArb)
  .map(([base, kind, keepExt, sha]) =>
    uploadText(keepExt ? `${base}${kind.ext}` : base, kind.mime, sha),
  );
