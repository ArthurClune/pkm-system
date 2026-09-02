// pattern: Imperative Shell
import {
  act, fireEvent, render, screen, waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetSearchItem, AssetSearchPayload } from "../api/payloads";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { makeSync } from "../test-helpers";
import { Files } from "./Files";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
vi.mock("../sync/SyncProvider", () => ({ useSyncHealth: vi.fn() }));
// The real PdfEmbed lazy-imports react-pdf/pdfjs; stub it with a dialog that
// exposes its props so these tests only assert the card -> viewer wiring.
vi.mock("../components/PdfEmbed", () => ({
  PdfEmbed: ({ href, label, onClose }:
      { href: string; label: string; onClose?: () => void }) => (
    <div role="dialog" aria-label={`PDF: ${label}`} data-href={href}>
      <button type="button" onClick={onClose}>Close</button>
    </div>
  ),
}));

import { apiFetch } from "../api/client";
import { useSyncHealth } from "../sync/SyncProvider";

const mockFetch = vi.mocked(apiFetch);
const mockSync = vi.mocked(useSyncHealth);

const item = (over: Partial<AssetSearchItem>): AssetSearchItem => ({
  sha256: "ab".repeat(32), filename: "pic.png", mime: "image/png",
  size: 1234, created_at: 1753000000000,
  url: `/assets/${"ab".repeat(32)}/pic.png`, description: null,
  status: "described", describe_error: null, refs: [], ...over,
});

const payload = (assets: AssetSearchItem[],
                 total = assets.length): AssetSearchPayload =>
  ({ total, assets });

const renderFiles = () =>
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/files"]}>
      <Files />
    </MemoryRouter>,
  );

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSync.mockReturnValue(makeSync("connected"));
  mockFetch.mockResolvedValue(payload([]));
});

describe("Files", () => {
  it("shows the offline note without fetching when disconnected", () => {
    mockSync.mockReturnValue(makeSync("reconnecting"));
    renderFiles();
    expect(screen.getByText(/needs a connection/i)).toHaveClass("settings-note");
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("shows an empty state", async () => {
    renderFiles();
    expect(await screen.findByText(/no files match/i)).toHaveClass("settings-note");
  });

  it("shows an error state when the fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("boom"));
    renderFiles();
    expect(
      await screen.findByText(/could not load files/i),
    ).toBeInTheDocument();
  });

  it("renders cards with badges, thumbnail, and count line", async () => {
    mockFetch.mockResolvedValue(payload([
      item({}),
      item({
        sha256: "cd".repeat(32), filename: "notes.pdf",
        mime: "application/pdf", status: "failed",
        describe_error: "too large",
        refs: [{ uid: "b1", page_title: "AI" }],
      }),
    ]));
    renderFiles();
    expect(await screen.findByText("pic.png")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "pic.png" }))
      .toHaveAttribute("src", expect.stringContaining("/assets/"));
    expect(screen.getByText("orphan")).toBeInTheDocument();
    expect(screen.getByText("1 ref")).toBeInTheDocument();
    expect(screen.getByText("failed")).toHaveAttribute(
      "title", "too large");
    expect(screen.getByText("2 of 2 files")).toBeInTheDocument();
  });

  it("styles the filter widgets with the shared tokens (pkm-mrru, pkm-0wg9)",
     async () => {
    renderFiles();
    await screen.findByText(/no files match/i);
    for (const name of ["Type", "From", "To", "Linked"]) {
      expect(screen.getByLabelText(name)).toHaveClass("input-control");
    }
    // the search box is the same object as the Cmd-U search, icon and all
    const search = screen.getByLabelText("Search names & descriptions");
    expect(search).toHaveClass("search-field-input");
    expect(search.closest(".search-field")).not.toBeNull();
  });

  it("passes filters to the search request", async () => {
    renderFiles();
    await screen.findByText(/no files match/i);
    fireEvent.change(screen.getByLabelText("Type"),
                     { target: { value: "pdf" } });
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("type=pdf"), { method: "GET" }));
    fireEvent.change(screen.getByLabelText("Linked"),
                     { target: { value: "orphan" } });
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("linked=orphan"), { method: "GET" }));
  });

  it("loads more pages and selects all across pages", async () => {
    const first = Array.from({ length: 50 }, (_, i) =>
      item({ sha256: String(i).padStart(64, "0"),
             filename: `f${i}.png` }));
    const second = [item({ sha256: "ee".repeat(32),
                           filename: "last.png" })];
    mockFetch
      .mockResolvedValueOnce(payload(first, 51))
      .mockResolvedValueOnce(payload(second, 51));
    renderFiles();
    expect(await screen.findByText("50 of 51 files")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    await screen.findByText("51 selected");
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("offset=50"), { method: "GET" });
  });

  it("discards a stale loadMore response when filters change first (pkm-3622)",
     async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) =>
      item({ sha256: String(i).padStart(64, "0"), filename: `f${i}.png` }));
    const stale = deferred<AssetSearchPayload>();
    const filtered = payload(
      [item({ sha256: "cd".repeat(32), filename: "notes.pdf" })], 1);
    mockFetch
      .mockResolvedValueOnce(payload(firstPage, 60))   // initial reload
      .mockResolvedValueOnce(stale.promise)             // loadMore (offset=50)
      .mockResolvedValueOnce(filtered);                 // filter-change reload
    renderFiles();
    expect(await screen.findByText("50 of 60 files")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Load more" }));
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("offset=50"), { method: "GET" }));

    fireEvent.change(screen.getByLabelText("Type"),
                     { target: { value: "pdf" } });
    expect(await screen.findByText("1 of 1 files")).toBeInTheDocument();
    expect(screen.getByText("notes.pdf")).toBeInTheDocument();

    // The stale loadMore response resolves after the filter change has
    // already landed; it must be discarded, not merged in or overwrite total.
    stale.resolve(payload(firstPage.slice(0, 5), 999));
    await act(async () => { await stale.promise; await Promise.resolve(); });
    expect(screen.getByText("1 of 1 files")).toBeInTheDocument();
    expect(screen.queryByText("f0.png")).not.toBeInTheDocument();
  });

  it("runs only one Load more request for two clicks before rerender (pkm-ow62)",
     async () => {
    const first = Array.from({ length: 50 }, (_, i) =>
      item({ sha256: String(i).padStart(64, "0"), filename: `f${i}.png` }));
    const pending = deferred<AssetSearchPayload>();
    const last = item({ sha256: "ef".repeat(32), filename: "last.png" });
    mockFetch
      .mockResolvedValueOnce(payload(first, 51))
      .mockReturnValueOnce(pending.promise);
    renderFiles();
    const button = await screen.findByRole("button", { name: "Load more" });

    act(() => {
      button.click();
      button.click();
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(button).toBeDisabled();
    await act(async () => {
      pending.resolve(payload([last], 51));
      await pending.promise;
    });
    expect(await screen.findByText("51 of 51 files")).toBeInTheDocument();
    expect(screen.getAllByText("last.png")).toHaveLength(1);
  });

  it("discards a stale selectAll response when filters change first " +
     "(pkm-3622)", async () => {
    const firstPage = Array.from({ length: 50 }, (_, i) =>
      item({ sha256: String(i).padStart(64, "0"), filename: `f${i}.png` }));
    const stale = deferred<AssetSearchPayload>();
    const filtered = payload(
      [item({ sha256: "cd".repeat(32), filename: "notes.pdf" })], 1);
    mockFetch
      .mockResolvedValueOnce(payload(firstPage, 51))   // initial reload
      .mockResolvedValueOnce(stale.promise)             // selectAll (offset=50)
      .mockResolvedValueOnce(filtered);                 // filter-change reload
    renderFiles();
    expect(await screen.findByText("50 of 51 files")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("offset=50"), { method: "GET" }));

    fireEvent.change(screen.getByLabelText("Type"),
                     { target: { value: "pdf" } });
    expect(await screen.findByText("1 of 1 files")).toBeInTheDocument();
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();

    // The stale selectAll page resolves after the filter change; it must not
    // select files outside the now-visible filter.
    stale.resolve(payload(
      [item({ sha256: "ee".repeat(32), filename: "last.png" })], 51));
    await act(async () => { await stale.promise; await Promise.resolve(); });
    expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
    expect(screen.getByText("notes.pdf")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Select all" }))
      .not.toBeDisabled();
  });

  it("deletes selected files after a calm confirm and reports", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    renderFiles();
    fireEvent.click(await screen.findByLabelText("Select pic.png"));
    mockFetch.mockResolvedValueOnce({ deleted: true, refs_removed: 0 });
    mockFetch.mockResolvedValueOnce(payload([]));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(
      /Delete 1 file\? None are linked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete file" }));
    expect(await screen.findByText("Deleted 1 file.")).toBeInTheDocument();
    expect(mockFetch).toHaveBeenCalledWith(
      `/api/assets/${"ab".repeat(32)}`, { method: "DELETE" });
  });

  it("disables the danger action while deletion is pending", async () => {
    const pending = deferred<{ deleted: boolean; refs_removed: number }>();
    mockFetch
      .mockResolvedValueOnce(payload([item({})]))
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(payload([]));
    renderFiles();
    fireEvent.click(await screen.findByLabelText("Select pic.png"));

    const deleteButton = screen.getByRole("button", { name: "Delete" });
    expect(deleteButton).toHaveClass("btn-danger");
    fireEvent.click(deleteButton);
    fireEvent.click(await screen.findByRole("button", { name: "Delete file" }));

    await waitFor(() => expect(deleteButton).toBeDisabled());
    await act(async () => {
      pending.resolve({ deleted: true, refs_removed: 0 });
      await pending.promise;
    });
    expect(await screen.findByText("Deleted 1 file.")).toBeInTheDocument();
  });

  it("goes loud when a linked file is selected and survives failures",
     async () => {
    const linked = item({
      refs: [{ uid: "b1", page_title: "AI" }] });
    const other = item({ sha256: "cd".repeat(32), filename: "b.png" });
    mockFetch.mockResolvedValueOnce(payload([linked, other]));
    renderFiles();
    fireEvent.click(await screen.findByLabelText("Select pic.png"));
    fireEvent.click(screen.getByLabelText("Select b.png"));
    mockFetch
      .mockRejectedValueOnce(new Error("500"))     // delete pic.png
      .mockResolvedValueOnce({ deleted: true, refs_removed: 0 })
      .mockResolvedValueOnce(payload([linked]));   // refetch
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(await screen.findByText(/still linked/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Delete files" }));
    expect(await screen.findByText(
      "Deleted 1 of 2 files. Failed: pic.png")).toBeInTheDocument();
  });

  it("cancelling the confirm deletes nothing", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    renderFiles();
    fireEvent.click(await screen.findByLabelText("Select pic.png"));
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(mockFetch).not.toHaveBeenCalledWith(
      expect.stringContaining("ab".repeat(32)),
      expect.objectContaining({ method: "DELETE" }));
  });

  it("copies an orphan's markdown token", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    renderFiles();
    fireEvent.click(await screen.findByRole("button",
                                            { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `![pic.png](/assets/${"ab".repeat(32)}/pic.png)`));
    expect(screen.getByText("Link copied.")).toBeInTheDocument();
  });

  it("runs a scan and reports the queue size", async () => {
    mockFetch.mockResolvedValueOnce(payload([]));
    renderFiles();
    await screen.findByText(/no files match/i);
    mockFetch.mockResolvedValueOnce(
      { queued: 4, enabled: true, reason: null });
    mockFetch.mockResolvedValueOnce(payload([]));
    fireEvent.click(screen.getByRole("button", { name: /Scan/ }));
    expect(await screen.findByText("Scan queued 4 files."))
      .toBeInTheDocument();
  });

  it("reports the disabled reason when describe is off", async () => {
    mockFetch.mockResolvedValueOnce(payload([]));
    renderFiles();
    await screen.findByText(/no files match/i);
    mockFetch.mockResolvedValueOnce(
      { queued: 0, enabled: false, reason: "no key" });
    mockFetch.mockResolvedValueOnce(payload([]));
    fireEvent.click(screen.getByRole("button", { name: /Scan/ }));
    expect(await screen.findByText(/disabled — no key/))
      .toBeInTheDocument();
  });

  it("submits a hidden form for export", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    const submit = vi.spyOn(HTMLFormElement.prototype, "submit")
      .mockImplementation(() => {});
    renderFiles();
    fireEvent.click(await screen.findByLabelText("Select pic.png"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(submit).toHaveBeenCalledOnce();
    submit.mockRestore();
  });

  it("falls back to a type label when the image is broken", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    renderFiles();
    fireEvent.error(await screen.findByRole("img", { name: "pic.png" }));
    expect(screen.getByText("image")).toBeInTheDocument();
  });

  it("expands an image thumbnail in-app instead of opening a tab", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    renderFiles();
    const thumb = await screen.findByRole("button",
                                          { name: "Expand image: pic.png" });
    expect(thumb.closest("a")).toBeNull();
    fireEvent.click(thumb);
    const overlay = screen.getByRole("dialog",
                                     { name: "Expanded image: pic.png" });
    expect(overlay).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog",
                              { name: "Expanded image: pic.png" }))
      .not.toBeInTheDocument();
  });

  it("opens a PDF in the in-app viewer instead of a tab (pkm-5o11)",
     async () => {
    const url = `/assets/${"cd".repeat(32)}/notes.pdf`;
    mockFetch.mockResolvedValueOnce(payload([item({
      sha256: "cd".repeat(32), filename: "notes.pdf",
      mime: "application/pdf", url,
    })]));
    renderFiles();
    const thumb = await screen.findByRole("button",
                                          { name: "Open PDF: notes.pdf" });
    expect(thumb.closest("a")).toBeNull();
    fireEvent.click(thumb);
    const dialog = screen.getByRole("dialog", { name: "PDF: notes.pdf" });
    expect(dialog).toHaveAttribute("data-href", url);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "PDF: notes.pdf" }))
      .not.toBeInTheDocument();
    expect(thumb).toHaveFocus();
  });

  it("keeps the new-tab link for document and other files", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({
      sha256: "cd".repeat(32), filename: "notes.txt",
      mime: "text/plain",
    })]));
    renderFiles();
    await screen.findByText("notes.txt");
    const label = screen.getByText("document");
    const link = label.closest("a");
    expect(link).toHaveAttribute("target", "_blank");
    expect(screen.queryByRole("button", { name: /Expand image|Open PDF/ }))
      .not.toBeInTheDocument();
  });

  it("opens the refs popover from the refs badge", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.startsWith("/api/block-refs")) {
        return Promise.resolve({ block_ref_texts: {
          b1: { text: "embeds the pic", page_title: "AI" } } });
      }
      return Promise.resolve(payload([item({
        refs: [{ uid: "b1", page_title: "AI" }] })]));
    });
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "1 ref" }));
    const popover = await screen.findByRole("dialog",
                                            { name: "References" });
    expect(popover).toHaveClass("block-ref-popover");
    expect(await screen.findByText("embeds the pic")).toBeInTheDocument();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "References" }))
      .not.toBeInTheDocument();
  });

  it("keeps the orphan badge inert", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    renderFiles();
    const badge = await screen.findByText("orphan");
    expect(badge.tagName).toBe("SPAN");
  });

  it("shows the description from the described badge", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({
      description: "a bar chart of monthly revenue" })]));
    renderFiles();
    fireEvent.click(await screen.findByRole("button",
                                            { name: "described" }));
    expect(screen.getByRole("dialog", { name: "Description" }))
      .toHaveTextContent("a bar chart of monthly revenue");
  });

  it("shows the error from the failed badge", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({
      status: "failed", describe_error: "too large" })]));
    renderFiles();
    fireEvent.click(await screen.findByRole("button", { name: "failed" }));
    expect(screen.getByRole("dialog", { name: "Description error" }))
      .toHaveTextContent("too large");
  });

  it("keeps the pending badge inert", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({ status: "pending" })]));
    renderFiles();
    const badge = await screen.findByText("pending");
    expect(badge.tagName).toBe("SPAN");
  });
});
