import { expect, it } from "vitest";
import { firstBlockTexts, parseTemplate,
         templatesFromFiles } from "./pageTemplates";
import { PAGE_TEMPLATES } from "./load";

it("parses one block per '- ' line, padding a bare 'Key::'", () => {
  expect(parseTemplate("- Tags:: #Paper\n- URL::\n"))
    .toEqual(["Tags:: #Paper", "URL:: "]);
});

it("accepts CRLF and blank lines", () => {
  expect(parseTemplate("- A::\r\n\r\n- B:: x\r\n")).toEqual(["A:: ", "B:: x"]);
});

it.each(["  - nested::", "Tags:: #Paper", "-Tags::"])(
  "rejects a template with the line %j", (line) => {
    expect(parseTemplate(`- ok::\n${line}\n`)).toBeNull();
  });

it("rejects a template with no blocks", () => {
  expect(parseTemplate("\n\n")).toBeNull();
});

it("names a template by its file and drops unparseable files", () => {
  const t = templatesFromFiles({ "./Paper.md": "- URL::", "./Bad.md": " x" });
  expect([...t.keys()]).toEqual(["Paper"]);
});

it.each([
  ["Paper/Agents of Chaos", ["Tags:: #Paper", "URL:: "]],
  ["Paper/a/b", ["Tags:: #Paper", "URL:: "]],
  ["Papers/x", [""]], ["paper/x", [""]], ["Paperback", [""]],
  ["Paper", [""]], ["Page", [""]],
])("picks the template for %j", (title, texts) => {
  const t = new Map([["Paper", ["Tags:: #Paper", "URL:: "]]]);
  expect(firstBlockTexts(title, t)).toEqual(texts);
});

it("ships the Paper and Book templates as specified", () => {
  expect(PAGE_TEMPLATES.get("Paper"))
    .toEqual(["Tags:: #Paper", "URL:: ", "Date:: ", "Local copy:: "]);
  expect(PAGE_TEMPLATES.get("Book")).toEqual(["Tags:: #Book", "Author:: ",
    "Reading Status:: ", "Published:: ", "Format:: ", "Summary:: "]);
});

it("every shipped template file parses", () => {
  const files = import.meta.glob("./*.md",
    { query: "?raw", import: "default", eager: true });
  expect(PAGE_TEMPLATES.size).toBe(Object.keys(files).length);
});
