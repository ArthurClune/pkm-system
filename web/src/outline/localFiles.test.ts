import { expect, test } from "vitest";
import {
  folderListing,
  localCopyAttribute,
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
