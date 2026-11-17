import { expect, it } from "vitest";
import { canonicalTitleOf, rawTitleOf } from "../test-mint";
import { firstBlockTexts, parseTemplate, seedTemplateState, templateFor,
         templatesFromFiles, wantsTemplateSeed } from "./pageTemplates";
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
])("picks the template for %j", (titleText, texts) => {
  const t = new Map([["Paper", ["Tags:: #Paper", "URL:: "]]]);
  expect(firstBlockTexts(canonicalTitleOf(titleText), t)).toEqual(texts);
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

const PAPER = new Map([["Paper", ["Tags:: #Paper", "URL:: "]]]);

it("finds a title's template, or null when it has none", () => {
  expect(templateFor(rawTitleOf("Paper/x"), PAPER))
    .toEqual(["Tags:: #Paper", "URL:: "]);
  for (const t of ["Papers/x", "paper/x", "Paper"]) {
    expect(templateFor(rawTitleOf(t), PAPER)).toBeNull();
  }
});

it("marks a navigation only toward a title with a template", () => {
  const t = new Map([["Book", ["Tags:: #Book"]]]);
  expect(seedTemplateState(rawTitleOf("Book/y"), t))
    .toEqual({ seedTemplate: true });
  expect(seedTemplateState(rawTitleOf("Page"), t)).toBeUndefined();
});

it.each([
  [{ seedTemplate: true }, true], [null, false], [undefined, false],
  ["x", false], [{}, false], [{ seedTemplate: "yes" }, false],
])("reads router state %j as a seed request: %j", (state, wanted) => {
  expect(wantsTemplateSeed(state)).toBe(wanted);
});
