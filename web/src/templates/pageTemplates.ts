// pattern: Functional Core
// Page templates: the blocks "Click to start writing…" seeds on an empty
// page whose title sits under a template's namespace. Each markdown file in
// this directory is one template, named for its namespace (`Paper.md` for
// `Paper/…` titles), with one `- text` line per top-level block.
import type { CanonicalTitle } from "../api/brands";

/** Namespace -> the block texts its template seeds, in order. */
export type PageTemplates = ReadonlyMap<string, readonly string[]>;

const LINE_RE = /^- (.*)$/;

/** The block texts of one template file, or null when any non-blank line
 * is not a `- text` line at column 0 or there are none. A text ending in
 * `::` gets a trailing space, which editors strip from the file, so the
 * caret lands where the attribute's value goes. */
export function parseTemplate(markdown: string): string[] | null {
  const texts: string[] = [];
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line === "") continue;
    const m = LINE_RE.exec(line);
    if (!m) return null;
    texts.push(m[1].endsWith("::") ? `${m[1]} ` : m[1]);
  }
  return texts.length > 0 ? texts : null;
}

/** Templates keyed by namespace from glob results keyed by file path
 * (`./Paper.md`). An unparseable file is left out rather than seeding
 * something half-formed. */
export function templatesFromFiles(
  files: Readonly<Record<string, string>>,
): PageTemplates {
  const templates = new Map<string, readonly string[]>();
  for (const [path, markdown] of Object.entries(files)) {
    const texts = parseTemplate(markdown);
    const name = path.split("/").pop()?.replace(/\.md$/, "");
    if (texts && name) templates.set(name, texts);
  }
  return templates;
}

/** The texts of the blocks a fresh page starts with: its namespace's
 * template, else one empty block. Matching is exact and case-sensitive. */
export function firstBlockTexts(
  title: CanonicalTitle, templates: PageTemplates,
): readonly string[] {
  const slash = title.indexOf("/");
  const texts = slash > 0 ? templates.get(title.slice(0, slash)) : undefined;
  return texts ?? [""];
}
