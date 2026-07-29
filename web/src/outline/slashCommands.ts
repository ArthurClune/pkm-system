// pattern: Functional Core
// Static command list + text transforms for the `/` command menu (detection
// lives in autocomplete.ts's "command" AcContext kind). Each command consumes
// the "/query" trigger text and rewrites the surrounding block content; the
// fence format matches tokenize.ts's parseFence (```lang\ncode\n```) and TODO
// markers are detected via the shared grammar scanner (grammar/todo.ts's
// hasTodoMarker), so round-tripping through the renderer stays consistent.
//
// /text inserts a "text block": a fence with no language tag. parseFence
// turns a lang-less fence (```\n...\n```) into a code-block with lang null,
// which CodeBlock renders unhighlighted — that's the plain/verbatim text
// block. If the content is already a whole fence (any language, e.g. a
// Python block), /text unwraps it first so the result isn't double-fenced.
import { hasTodoMarker } from "../grammar/todo";
import { titleForDate } from "../replica/daily";
import type { AcContext } from "./autocomplete";

export interface SlashCommand {
  name: string;
  label: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "text", label: "text" },
  { name: "todo", label: "to-do" },
  { name: "table", label: "table" },
  { name: "python", label: "python code block" },
  { name: "bash", label: "bash code block" },
  { name: "javascript", label: "javascript code block" },
  { name: "mermaid", label: "mermaid diagram" },
  // "upload" has no text transform: picking it strips the trigger and opens a
  // file picker (handled in BlockInput), then splices the asset markdown.
  { name: "upload", label: "upload file…" },
  { name: "h1", label: "heading 1" },
  { name: "h2", label: "heading 2" },
  { name: "h3", label: "heading 3" },
  { name: "normal", label: "normal text" },
  { name: "query-and", label: "query (and)" },
  { name: "query-or", label: "query (or)" },
  { name: "query-and-not", label: "query (and not)" },
  // Daily-note link shortcuts (pkm-rw6w). applySlashCommand takes the
  // current date from the shell (clock reads are I/O, so the core never
  // calls new Date() itself).
  { name: "today", label: "link to today" },
  { name: "tomorrow", label: "link to tomorrow" },
];

/** Commands that set a block's heading field (a SetHeadingOp) rather than
 * transforming its text. `null` ("normal") always clears the heading; 1-3
 * are resolved through resolveHeading so picking the block's current
 * heading again toggles it back to plain text. */
const HEADING_COMMANDS: Partial<Record<string, number | null>> = {
  h1: 1, h2: 2, h3: 3, normal: null,
};

/** What heading a /hN or /normal pick should set, given the block's current
 * heading. Returns undefined for commands that aren't heading commands (the
 * caller should fall back to a plain text transform). */
export function resolveHeading(command: string,
                               current: number | null): number | null | undefined {
  if (!(command in HEADING_COMMANDS)) return undefined;
  const target = HEADING_COMMANDS[command] as number | null;
  return target === null ? null : current === target ? null : target;
}

export function matchSlashCommands(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q));
}

const WHOLE_FENCE_RE = /^```(\S*)\n([\s\S]*)\n```$/;

function unwrapFence(content: string): { text: string; cursor: number } {
  const m = WHOLE_FENCE_RE.exec(content);
  const text = m ? m[2] : content;
  return { text, cursor: text.length };
}

function wrapFence(content: string, lang: string): { text: string; cursor: number } {
  const text = "```" + lang + "\n" + content + "\n```";
  return { text, cursor: text.length - 4 }; // right before the closing "\n```"
}

function applyTodoPrefix(content: string): { text: string; cursor: number } {
  const text = hasTodoMarker(content) ? content : "{{TODO}} " + content;
  return { text, cursor: text.length };
}

/** {{query: ...}} expression skeletons per command, operands left as bare
 * "A" / "B" placeholders (not [[A]] / [[B]] page links -- pkm-nl6h: real
 * [[...]] tokens get ref-indexed and their pages auto-created the moment
 * the block's draft flushes, even if the user never edits the placeholder.
 * The user replaces "A" / "B" with real [[Page]] links (see queryPlaceholder
 * below and docs/keyboard.md); until then the query is invalid syntax and
 * QueryBlock surfaces the server's parse error, same as any other malformed
 * {{query: ...}} the user might type by hand. The clause skeleton itself
 * must still match the server's parse_query grammar (server/src/pkm/server/
 * query.py) once real [[Page]] operands are dropped in. */
const QUERY_EXPRESSIONS: Record<string, string> = {
  "query-and": "{and: A B}",
  "query-or": "{or: A B}",
  "query-and-not": "{and: A {not: B}}",
};

function queryPlaceholder(command: string, content: string): { text: string; cursor: number } {
  if (content.trim()) return { text: content, cursor: content.length };
  const text = "{{query: " + QUERY_EXPRESSIONS[command] + "}}";
  return { text, cursor: text.length };
}

/** Insert a "text block": a lang-less fence wrapping the content, cursor
 * placed inside it. Unwraps first if the content is already a whole fence
 * (of any language) so re-running /text (or converting a code block) doesn't
 * double-fence it. */
function textBlock(content: string): { text: string; cursor: number } {
  return wrapFence(unwrapFence(content).text, "");
}

/** Insert a [[daily-note]] link for `d` at `at`, cursor after the link. */
function dailyLink(content: string, at: number, d: Date): { text: string; cursor: number } {
  const link = `[[${titleForDate(d)}]]`;
  const text = content.slice(0, at) + link + content.slice(at);
  return { text, cursor: at + link.length };
}

/** Remove the "/query" trigger and apply `command`'s transform to what's
 * left. Heading commands (h1/h2/h3/normal) have no text transform of their
 * own — they fall through to the default (trigger stripped, nothing else)
 * because the heading field itself is set separately via resolveHeading
 * and a SetHeadingOp. */
export function applySlashCommand(
  text: string, cursor: number, ctx: AcContext, command: string, now: Date,
): { text: string; cursor: number } {
  const content = text.slice(0, ctx.start - 1) + text.slice(cursor);
  switch (command) {
    case "text": return textBlock(content);
    case "todo": return applyTodoPrefix(content);
    case "table":
      return content.trim()
        ? { text: content, cursor: content.length }
        : { text: "{{table}}", cursor: "{{table}}".length };
    case "python": case "bash": case "javascript": case "mermaid":
      return wrapFence(content, command);
    case "query-and": case "query-or": case "query-and-not":
      return queryPlaceholder(command, content);
    case "today": return dailyLink(content, ctx.start - 1, now);
    case "tomorrow":
      return dailyLink(content, ctx.start - 1,
        new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    default: return { text: content, cursor: content.length };
  }
}
