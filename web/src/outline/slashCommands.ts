// pattern: Functional Core
// Static command list + text transforms for the `/` command menu (detection
// lives in autocomplete.ts's "command" AcContext kind). Each command consumes
// the "/query" trigger text and rewrites the surrounding block content; the
// fence format matches tokenize.ts's parseFence (```lang\ncode\n```) and the
// TODO prefix matches its TODO_PREFIX regex exactly, so round-tripping through
// the renderer stays consistent.
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
];

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

/** Remove the "/query" trigger and apply `command`'s transform to what's left. */
export function applySlashCommand(
  text: string, cursor: number, ctx: AcContext, command: string,
): { text: string; cursor: number } {
  const content = text.slice(0, ctx.start - 1) + text.slice(cursor);
  switch (command) {
    case "text": return unwrapFence(content);
    case "todo": return applyTodoPrefix(content);
    case "python": case "bash": case "javascript": return wrapFence(content, command);
    default: return { text: content, cursor: content.length };
  }
}
