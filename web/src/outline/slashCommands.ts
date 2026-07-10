// pattern: Functional Core
// Static command list + text transforms for the `/` command menu (detection
// lives in autocomplete.ts's "command" AcContext kind). Each command consumes
// the "/query" trigger text and rewrites the surrounding block content; the
// fence format matches tokenize.ts's parseFence (```lang\ncode\n```) and the
// TODO prefix matches its TODO_PREFIX regex exactly, so round-tripping through
// the renderer stays consistent.
//
// /text inserts a "text block": a fence with no language tag. parseFence
// turns a lang-less fence (```\n...\n```) into a code-block with lang null,
// which CodeBlock renders unhighlighted — that's the plain/verbatim text
// block. If the content is already a whole fence (any language, e.g. a
// Python block), /text unwraps it first so the result isn't double-fenced.
import type { AcContext } from "./autocomplete";

export interface SlashCommand {
  name: string;
  label: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "text", label: "Text" },
  { name: "todo", label: "To-do" },
  { name: "python", label: "Python code block" },
  { name: "bash", label: "Bash code block" },
  { name: "javascript", label: "JavaScript code block" },
  { name: "mermaid", label: "Mermaid diagram" },
  { name: "h1", label: "Heading 1" },
  { name: "h2", label: "Heading 2" },
  { name: "h3", label: "Heading 3" },
  { name: "normal", label: "Normal text" },
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

const TODO_PREFIX_RE = /^\{\{(?:\[\[)?(TODO|DONE)(?:\]\])?\}\}\s?/;
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
  const text = TODO_PREFIX_RE.test(content) ? content : "{{TODO}} " + content;
  return { text, cursor: text.length };
}

/** Insert a "text block": a lang-less fence wrapping the content, cursor
 * placed inside it. Unwraps first if the content is already a whole fence
 * (of any language) so re-running /text (or converting a code block) doesn't
 * double-fence it. */
function textBlock(content: string): { text: string; cursor: number } {
  return wrapFence(unwrapFence(content).text, "");
}

/** Remove the "/query" trigger and apply `command`'s transform to what's
 * left. Heading commands (h1/h2/h3/normal) have no text transform of their
 * own — they fall through to the default (trigger stripped, nothing else)
 * because the heading field itself is set separately via resolveHeading
 * and a SetHeadingOp. */
export function applySlashCommand(
  text: string, cursor: number, ctx: AcContext, command: string,
): { text: string; cursor: number } {
  const content = text.slice(0, ctx.start - 1) + text.slice(cursor);
  switch (command) {
    case "text": return textBlock(content);
    case "todo": return applyTodoPrefix(content);
    case "python": case "bash": case "javascript": case "mermaid":
      return wrapFence(content, command);
    default: return { text: content, cursor: content.length };
  }
}
