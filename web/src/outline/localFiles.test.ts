import { expect, test } from "vitest";
import {
  folderListing,
  localCopyAttribute,
  searchLocalFiles,
  type LocalFile,
} from "./localFiles";

const F = (path: string): LocalFile => ({ path, href: `/api/local/${path}` });
const files = [
  F("Papers/Machine Learning/LLMs/SHARED GEOMETRY AS A ROSETTA STONE.pdf"),
  F("Papers/Machine Learning/Underspecification Presents Challenges.pdf"),
  F("Books/Maths/Category theory/Category Theory For Scientists.pdf"),
  F("White Papers/Bitcoin/WEF_DAOs.pdf"),
];

test("folderListing lists child folders and direct files", () => {
  expect(folderListing(files, "")).toEqual({
    folders: ["Books", "Papers", "White Papers"],
    files: [],
  });
  expect(folderListing(files, "Papers/Machine Learning")).toEqual({
    folders: ["LLMs"],
    files: [files[1]],
  });
});

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

test("localCopyAttribute keeps the real name whenever the link reads back", () => {
  expect(
    localCopyAttribute({
      path: "P/x [draft] y.pdf",
      href: "/api/local/P/x%20%5Bdraft%5D%20y.pdf",
    }),
  ).toBe("Local copy:: [x [draft] y.pdf](/api/local/P/x%20%5Bdraft%5D%20y.pdf)");
  expect(
    localCopyAttribute({ path: "P/plain.pdf", href: "/api/local/P/plain.pdf" }),
  ).toBe("Local copy:: [plain.pdf](/api/local/P/plain.pdf)");
});

test("localCopyAttribute swaps brackets only when the name would break the link", () => {
  expect(
    localCopyAttribute({
      path: "P/[2019 draft.pdf",
      href: "/api/local/P/%5B2019%20draft.pdf",
    }),
  ).toBe("Local copy:: [(2019 draft.pdf](/api/local/P/%5B2019%20draft.pdf)");
  expect(
    localCopyAttribute({
      path: "P/[a] b.pdf",
      href: "/api/local/P/%5Ba%5D%20b.pdf",
    }),
  ).toBe("Local copy:: [(a) b.pdf](/api/local/P/%5Ba%5D%20b.pdf)");
  expect(
    localCopyAttribute({
      path: "P/a ]b.pdf",
      href: "/api/local/P/a%20%5Db.pdf",
    }),
  ).toBe("Local copy:: [a )b.pdf](/api/local/P/a%20%5Db.pdf)");
});

test("regex metacharacters in the query are literal", () => {
  expect(
    searchLocalFiles([F("a/(x).pdf"), F("a/y.pdf")], "(x").map((m) => m.file.path),
  ).toEqual(["a/(x).pdf"]);
});
