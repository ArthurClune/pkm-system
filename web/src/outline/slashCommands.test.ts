import { describe, expect, test } from "vitest";
import { extractRefs } from "../grammar/refs";
import { toggleTodo } from "../grammar/todo";
import { tokenizeBlock } from "../grammar/tokenize";
import { applySlashCommand, matchSlashCommands, resolveHeading,
         SLASH_COMMANDS } from "./slashCommands";

describe("matchSlashCommands", () => {
  test("empty query returns the full list", () => {
    expect(matchSlashCommands("")).toEqual(SLASH_COMMANDS);
  });

  test("filters by prefix, case-insensitively", () => {
    expect(matchSlashCommands("py")).toEqual([{ name: "python", label: "python code block" }]);
    expect(matchSlashCommands("PY")).toEqual([{ name: "python", label: "python code block" }]);
  });

  test("no match returns an empty list", () => {
    expect(matchSlashCommands("zzz")).toEqual([]);
  });
});

describe("applySlashCommand: /python /bash /javascript", () => {
  test("wraps an empty block in a fence, cursor inside it", () => {
    expect(applySlashCommand("/python", 7, { kind: "command", start: 1, query: "python" }, "python"))
      .toEqual({ text: "```python\n\n```", cursor: 10 });
  });

  test("wraps existing content around the trigger", () => {
    // "foo /py" — trigger is "/py" at index 4, cursor at end
    expect(applySlashCommand("foo /py", 7, { kind: "command", start: 5, query: "py" }, "python"))
      .toEqual({ text: "```python\nfoo \n```", cursor: 14 });
  });

  test("bash and javascript use their own fence language", () => {
    expect(applySlashCommand("/bash", 5, { kind: "command", start: 1, query: "bash" }, "bash"))
      .toEqual({ text: "```bash\n\n```", cursor: 8 });
    expect(applySlashCommand("/js", 3, { kind: "command", start: 1, query: "js" }, "javascript"))
      .toEqual({ text: "```javascript\n\n```", cursor: 14 });
  });

  test("mermaid is offered and wraps in a mermaid fence (pkm-x2ep)", () => {
    expect(matchSlashCommands("mer")).toEqual([{ name: "mermaid", label: "mermaid diagram" }]);
    expect(applySlashCommand("/mermaid", 8, { kind: "command", start: 1, query: "mermaid" }, "mermaid"))
      .toEqual({ text: "```mermaid\n\n```", cursor: 11 });
  });
});

describe("applySlashCommand: /text", () => {
  test("wraps an empty block in a lang-less fence, cursor inside it", () => {
    expect(applySlashCommand("/text", 5, { kind: "command", start: 1, query: "text" }, "text"))
      .toEqual({ text: "```\n\n```", cursor: 4 });
  });

  test("wraps existing plain content in a lang-less fence", () => {
    expect(applySlashCommand("plain /text", 11, { kind: "command", start: 7, query: "text" }, "text"))
      .toEqual({ text: "```\nplain \n```", cursor: 10 });
  });

  test("converts an existing whole-block code fence to a lang-less fence, keeping its content", () => {
    const content = "```python\nprint(1)\n```/text";
    expect(applySlashCommand(content, content.length,
                             { kind: "command", start: content.length - 4, query: "text" },
                             "text"))
      .toEqual({ text: "```\nprint(1)\n```", cursor: 12 });
  });
});

describe("table", () => {
  test("table is offered and creates an exact renderable macro", () => {
    expect(matchSlashCommands("tab")).toEqual([{ name: "table", label: "table" }]);
    expect(applySlashCommand("/table", 6,
      { kind: "command", start: 1, query: "table" }, "table"))
      .toEqual({ text: "{{table}}", cursor: 9 });
  });

  test("does not discard existing content when /table is picked mid-block", () => {
    expect(applySlashCommand("notes /table", 12,
      { kind: "command", start: 7, query: "table" }, "table"))
      .toEqual({ text: "notes ", cursor: 6 });
  });
});

describe("query", () => {
  test("query-and is offered and inserts an and-clause skeleton", () => {
    expect(matchSlashCommands("query-and").map((c) => c.name)).toEqual(["query-and", "query-and-not"]);
    expect(applySlashCommand("/query-and", 10,
      { kind: "command", start: 1, query: "query-and" }, "query-and"))
      .toEqual({ text: "{{query: {and: A B}}}", cursor: 21 });
  });

  test("query-or is offered and inserts an or-clause skeleton", () => {
    expect(matchSlashCommands("query-or")).toEqual([
      { name: "query-or", label: "query (or)" },
    ]);
    expect(applySlashCommand("/query-or", 9,
      { kind: "command", start: 1, query: "query-or" }, "query-or"))
      .toEqual({ text: "{{query: {or: A B}}}", cursor: 20 });
  });

  test("query-and-not is offered and inserts an and/not-clause skeleton", () => {
    expect(matchSlashCommands("query-and-not")).toEqual([
      { name: "query-and-not", label: "query (and not)" },
    ]);
    expect(applySlashCommand("/query-and-not", 14,
      { kind: "command", start: 1, query: "query-and-not" }, "query-and-not"))
      .toEqual({ text: "{{query: {and: A {not: B}}}}", cursor: 28 });
  });

  // pkm-nl6h: the placeholder used to spell its operands as real [[A]] /
  // [[B]] page links, so merely picking the command (no further typing)
  // got them ref-indexed and their pages auto-created the moment the draft
  // flushed. The placeholder operands must never themselves be scannable
  // refs -- the user is expected to replace them with real [[Page]] links.
  test("query placeholders never contain a real [[...]] page-ref (pkm-nl6h)", () => {
    for (const command of ["query-and", "query-or", "query-and-not"]) {
      const { text } = applySlashCommand(`/${command}`, command.length + 1,
        { kind: "command", start: 1, query: command }, command);
      expect(extractRefs(text).refs).toEqual([]);
      expect(text).not.toContain("[[");
    }
  });

  test("matching 'query' returns all three query commands", () => {
    expect(matchSlashCommands("query")).toEqual([
      { name: "query-and", label: "query (and)" },
      { name: "query-or", label: "query (or)" },
      { name: "query-and-not", label: "query (and not)" },
    ]);
  });

  test("prefix matching narrows to a single query command", () => {
    expect(matchSlashCommands("query-a").map((c) => c.name)).toEqual(["query-and", "query-and-not"]);
    expect(matchSlashCommands("query-o").map((c) => c.name)).toEqual(["query-or"]);
  });

  test("does not discard existing content when a query command is picked mid-block", () => {
    expect(applySlashCommand("notes /query-and", 17,
      { kind: "command", start: 7, query: "query-and" }, "query-and"))
      .toEqual({ text: "notes ", cursor: 6 });
    expect(applySlashCommand("notes /query-or", 15,
      { kind: "command", start: 7, query: "query-or" }, "query-or"))
      .toEqual({ text: "notes ", cursor: 6 });
    expect(applySlashCommand("notes /query-and-not", 20,
      { kind: "command", start: 7, query: "query-and-not" }, "query-and-not"))
      .toEqual({ text: "notes ", cursor: 6 });
  });
});

describe("applySlashCommand: /todo", () => {
  test("prefixes the block with the TODO marker", () => {
    expect(applySlashCommand("/todo", 5, { kind: "command", start: 1, query: "todo" }, "todo"))
      .toEqual({ text: "{{TODO}} ", cursor: 9 });
    expect(applySlashCommand("buy milk /todo", 14,
                             { kind: "command", start: 10, query: "todo" }, "todo"))
      .toEqual({ text: "{{TODO}} buy milk ", cursor: 18 });
  });

  test("does not double-prefix an already-TODO block", () => {
    const content = "{{TODO}} buy milk /todo";
    expect(applySlashCommand(content, content.length,
                             { kind: "command", start: content.length - 4, query: "todo" }, "todo"))
      .toEqual({ text: "{{TODO}} buy milk ", cursor: 18 });
  });

  test("does not double-prefix the long [[ ]] marker spelling either", () => {
    const content = "{{[[TODO]]}} buy milk /todo";
    expect(applySlashCommand(content, content.length,
                             { kind: "command", start: content.length - 4, query: "todo" }, "todo"))
      .toEqual({ text: "{{[[TODO]]}} buy milk ", cursor: 22 });
  });

  test("/todo output is recognized by the tokenizer and the toggler", () => {
    const { text } = applySlashCommand("buy milk /todo", 14,
                                       { kind: "command", start: 10, query: "todo" }, "todo");
    expect(tokenizeBlock(text)[0]).toEqual({ kind: "todo", done: false });
    expect(toggleTodo(text)).toBe("{{DONE}} buy milk ");
  });
});

describe("applySlashCommand: /h1 /h2 /h3 /normal", () => {
  test("just strips the trigger — the heading field is set via a separate op", () => {
    expect(applySlashCommand("buy milk /h1", 12,
                             { kind: "command", start: 10, query: "h1" }, "h1"))
      .toEqual({ text: "buy milk ", cursor: 9 });
    expect(applySlashCommand("/h2", 3, { kind: "command", start: 1, query: "h2" }, "h2"))
      .toEqual({ text: "", cursor: 0 });
    expect(applySlashCommand("/normal", 7,
                             { kind: "command", start: 1, query: "normal" }, "normal"))
      .toEqual({ text: "", cursor: 0 });
  });
});

describe("matchSlashCommands: heading commands are listed", () => {
  test("h1/h2/h3/normal all appear in the static list", () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["h1", "h2", "h3", "normal"]));
  });

  test("prefix match narrows to the heading commands", () => {
    expect(matchSlashCommands("h").map((c) => c.name)).toEqual(["h1", "h2", "h3"]);
  });
});

describe("resolveHeading", () => {
  test("non-heading commands resolve to undefined (no heading op to dispatch)", () => {
    expect(resolveHeading("python", null)).toBeUndefined();
    expect(resolveHeading("text", 1)).toBeUndefined();
  });

  test("sets the target heading when the block isn't already that heading", () => {
    expect(resolveHeading("h1", null)).toBe(1);
    expect(resolveHeading("h2", 1)).toBe(2);
  });

  test("toggles back to plain text when the block is already that heading", () => {
    expect(resolveHeading("h1", 1)).toBeNull();
    expect(resolveHeading("h3", 3)).toBeNull();
  });

  test("/normal always clears, never toggles", () => {
    expect(resolveHeading("normal", null)).toBeNull();
    expect(resolveHeading("normal", 2)).toBeNull();
  });
});

describe("upload", () => {
  test("upload is offered in the command menu (pkm-coz9)", () => {
    expect(matchSlashCommands("up")).toEqual([{ name: "upload", label: "upload file…" }]);
  });
});
