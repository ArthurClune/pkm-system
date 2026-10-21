import { expect, test } from "vitest";
import type { LocalFile } from "./localFiles";
import { searchLocalFiles } from "./localSearch";

const F = (path: string): LocalFile => ({ path, href: `/api/local/${path}` });
const files = [
  F("Papers/Machine Learning/LLMs/SHARED GEOMETRY AS A ROSETTA STONE.pdf"),
  F("Papers/Machine Learning/Underspecification Presents Challenges.pdf"),
  F("Books/Maths/Category theory/Category Theory For Scientists.pdf"),
  F("White Papers/Bitcoin/WEF_DAOs.pdf"),
];

test("fuzzy: subsequence, case-insensitive, every word must match", () => {
  const top = (q: string) => searchLocalFiles(files, q).map((m) => m.file.path);
  expect(top("shrgeo")[0]).toBe(files[0].path);
  expect(top("llm geom")).toEqual([files[0].path]);
  expect(top("LLM GEOM")).toEqual([files[0].path]);
  expect(top("geom zzz")).toEqual([]);
  expect(top("   ")).toEqual([]);
});

test("a file-name match outranks a folder-only match", () => {
  const fs = [F("Category/notes.pdf"), F("Misc/Category theory.pdf")];
  expect(searchLocalFiles(fs, "category").map((m) => m.file.path)).toEqual([
    "Misc/Category theory.pdf",
    "Category/notes.pdf",
  ]);
});

test("no cap on results", () => {
  const many = Array.from({ length: 900 }, (_, i) => F(`P/paper ${i}.pdf`));
  expect(searchLocalFiles(many, "paper")).toHaveLength(900);
});

test("highlight ranges index into name and folder separately", () => {
  const m = searchLocalFiles([F("Papers/LLMs/Geo.pdf")], "llm geo")[0];
  expect(m.nameRanges).toEqual([[0, 3]]);
  expect(m.folderRanges).toEqual([[7, 10]]);
});

test("fzf's extended syntax works as in the terminal", () => {
  const top = (q: string) => searchLocalFiles(files, q).map((m) => m.file.path);
  expect(top("'Theory !Books")).toEqual([]);
  expect(top("'Theory")).toEqual([files[2].path]);
  expect(top("pdf$ ^White")).toEqual([files[3].path]);
});

test("regex metacharacters in the query are literal", () => {
  expect(
    searchLocalFiles([F("a/(x).pdf"), F("a/y.pdf")], "(x").map((m) => m.file.path),
  ).toEqual(["a/(x).pdf"]);
});

const slices = (text: string, ranges: [number, number][]) =>
  ranges.map(([s, e]) => text.slice(s, e));

test("NFD names highlight the characters that matched", () => {
  const path = "Re\u0301sume\u0301s/Cafe\u0301 notes.pdf";
  const m = searchLocalFiles([F(path)], "notes")[0];
  const nfc = path.normalize("NFC");
  const name = nfc.slice(nfc.lastIndexOf("/") + 1);
  expect(slices(name, m.nameRanges)).toEqual(["notes"]);
  expect(m.folderRanges).toEqual([]);
  expect(m.file.path).toBe(path);
});

test("NFD folder and name: every run slices to the matched text", () => {
  const path = "Re\u0301sume\u0301s/Cafe\u0301 notes.pdf";
  const nfc = path.normalize("NFC");
  const slash = nfc.lastIndexOf("/");
  const m = searchLocalFiles([F(path)], "sum caf pdf")[0];
  expect(slices(nfc.slice(0, slash), m.folderRanges)).toEqual(["sum"]);
  expect(slices(nfc.slice(slash + 1), m.nameRanges)).toEqual(["Caf", "pdf"]);
});

test("a folder-only NFD match does not count as a name match", () => {
  const fs = [
    F("Cafe\u0301s/zzz.pdf"),
    F("Misc/Cafe\u0301 menu.pdf"),
  ];
  expect(searchLocalFiles(fs, "caf").map((m) => m.file.path)).toEqual([
    fs[1].path,
    fs[0].path,
  ]);
});

test("a query character that lowercases to several code points still finds itself", () => {
  const fs = [F("a/İstanbul.pdf")];
  expect(searchLocalFiles(fs, "İ").map((m) => m.file.path)).toEqual([fs[0].path]);
});
