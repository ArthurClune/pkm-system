// A ((uid)) pasted after the page payload loaded is not in block_ref_texts;
// the provider fetches it on demand so the ref resolves live (pkm-y6af).
import { render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { stubFetch } from "../test-helpers";
import { BlockRef } from "./BlockRef";
import { BlockRefProvider } from "./BlockRefProvider";

test("resolves refs from the seed map without fetching", () => {
  const fetchMock = stubFetch([]);
  render(
    <BlockRefProvider seed={{ ref_aa1: { text: "seeded", page_title: "P" } }}>
      <BlockRef uid="ref_aa1" depth={0} />
    </BlockRefProvider>);
  expect(screen.getByText("seeded")).toBeInTheDocument();
  expect(fetchMock).not.toHaveBeenCalled();
});

test("fetches an unknown uid and resolves it live", async () => {
  stubFetch([["/api/block-refs", {
    block_ref_texts: { ref_bb2: { text: "fetched text", page_title: "Q" } },
  }]]);
  render(
    <BlockRefProvider seed={{}}>
      <BlockRef uid="ref_bb2" depth={0} />
    </BlockRefProvider>);
  expect(screen.getByText("((ref_bb2))")).toBeInTheDocument();
  await waitFor(() => {
    expect(screen.getByText("fetched text")).toBeInTheDocument();
  });
});

test("batches several unknown uids into one request", async () => {
  const fetchMock = stubFetch([["/api/block-refs", {
    block_ref_texts: {
      ref_cc3: { text: "gamma", page_title: "P" },
      ref_dd4: { text: "delta", page_title: "P" },
    },
  }]]);
  render(
    <BlockRefProvider seed={{}}>
      <BlockRef uid="ref_cc3" depth={0} />
      <BlockRef uid="ref_dd4" depth={0} />
    </BlockRefProvider>);
  await waitFor(() => {
    expect(screen.getByText("gamma")).toBeInTheDocument();
    expect(screen.getByText("delta")).toBeInTheDocument();
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const url = String(fetchMock.mock.calls[0][0]);
  expect(url).toContain("uids=ref_cc3,ref_dd4");
});

test("a uid the server doesn't know is fetched once, not in a loop", async () => {
  const fetchMock = stubFetch([["/api/block-refs", { block_ref_texts: {} }]]);
  const { rerender } = render(
    <BlockRefProvider seed={{}}>
      <BlockRef uid="ref_gone1" depth={0} />
    </BlockRefProvider>);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  rerender(
    <BlockRefProvider seed={{}}>
      <BlockRef uid="ref_gone1" depth={0} />
    </BlockRefProvider>);
  await new Promise((r) => setTimeout(r, 20));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByText("((ref_gone1))")).toBeInTheDocument();
});

test("the seed map wins over stale fetched entries", async () => {
  stubFetch([["/api/block-refs", {
    block_ref_texts: { ref_ee5: { text: "old text", page_title: "P" } },
  }]]);
  const { rerender } = render(
    <BlockRefProvider seed={{}}>
      <BlockRef uid="ref_ee5" depth={0} />
    </BlockRefProvider>);
  await waitFor(() => expect(screen.getByText("old text")).toBeInTheDocument());
  rerender(
    <BlockRefProvider seed={{ ref_ee5: { text: "payload text", page_title: "P" } }}>
      <BlockRef uid="ref_ee5" depth={0} />
    </BlockRefProvider>);
  expect(screen.getByText("payload text")).toBeInTheDocument();
});

test("a fetch failure leaves the ref unresolved without retry storms", async () => {
  const fetchMock = vi.fn(async () => new Response("{}", { status: 500 }));
  vi.stubGlobal("fetch", fetchMock);
  render(
    <BlockRefProvider seed={{}}>
      <BlockRef uid="ref_ff6" depth={0} />
    </BlockRefProvider>);
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  await new Promise((r) => setTimeout(r, 20));
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(screen.getByText("((ref_ff6))")).toBeInTheDocument();
});
