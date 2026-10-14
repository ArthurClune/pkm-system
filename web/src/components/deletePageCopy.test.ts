import { expect, it } from "vitest";
import { blockerReasonLabel, deleteConfirmMessage } from "./deletePageCopy";

const base = { links: 0, link_pages: 0, block_refs: 0, block_ref_pages: 0, blockers: [] };

it("says only that deletion cannot be undone when nothing points at the page", () => {
  expect(deleteConfirmMessage("Paper", base)).toBe('Delete "Paper"? This cannot be undone.');
});

it("adds the link sentence, singular", () => {
  expect(deleteConfirmMessage("Paper", { ...base, links: 1, link_pages: 1 })).toBe(
    'Delete "Paper"? This cannot be undone. 1 link on 1 page will become plain text.');
});

it("adds the link sentence, plural", () => {
  expect(deleteConfirmMessage("Paper", { ...base, links: 2, link_pages: 3 })).toBe(
    'Delete "Paper"? This cannot be undone. 2 links on 3 pages will become plain text.');
});

it("adds the block reference sentence, singular and plural", () => {
  expect(deleteConfirmMessage("Paper", { ...base, block_refs: 1, block_ref_pages: 1 })).toBe(
    'Delete "Paper"? This cannot be undone. 1 block reference on 1 page will be replaced with a copy of the text they point to.');
  expect(deleteConfirmMessage("Paper", { ...base, block_refs: 4, block_ref_pages: 2 })).toBe(
    'Delete "Paper"? This cannot be undone. 4 block references on 2 pages will be replaced with a copy of the text they point to.');
});

it("adds both sentences in order", () => {
  expect(deleteConfirmMessage("P", { ...base, links: 2, link_pages: 2, block_refs: 1, block_ref_pages: 1 })).toBe(
    'Delete "P"? This cannot be undone. 2 links on 2 pages will become plain text. 1 block reference on 1 page will be replaced with a copy of the text they point to.');
});

it("labels each blocker reason", () => {
  expect(blockerReasonLabel("query")).toBe("a query names this page");
  expect(blockerReasonLabel("used_as_attribute")).toBe("this page is used as an attribute");
  expect(blockerReasonLabel("attribute")).toBe("unlinking would make this an attribute");
  expect(blockerReasonLabel("residual")).toBe("unlinking would still leave a link to this page");
});
