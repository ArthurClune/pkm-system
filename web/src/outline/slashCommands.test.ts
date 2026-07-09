import { describe, expect, test } from "vitest";
import { applySlashCommand, matchSlashCommands, SLASH_COMMANDS } from "./slashCommands";

describe("matchSlashCommands", () => {
  test("empty query returns the full list", () => {
    expect(matchSlashCommands("")).toEqual(SLASH_COMMANDS);
  });

  test("filters by prefix, case-insensitively", () => {
    expect(matchSlashCommands("py")).toEqual([{ name: "python", label: "Python code block" }]);
    expect(matchSlashCommands("PY")).toEqual([{ name: "python", label: "Python code block" }]);
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
});

describe("applySlashCommand: /text", () => {
  test("unwraps a whole-block code fence back to plain text", () => {
    const content = "```python\nprint(1)\n```/text";
    expect(applySlashCommand(content, content.length,
                             { kind: "command", start: content.length - 4, query: "text" },
                             "text"))
      .toEqual({ text: "print(1)", cursor: 8 });
  });

  test("is a no-op (just removes the trigger) when the block is not a fence", () => {
    expect(applySlashCommand("plain /text", 11, { kind: "command", start: 7, query: "text" }, "text"))
      .toEqual({ text: "plain ", cursor: 6 });
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
});
