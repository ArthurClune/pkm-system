// pattern: Imperative Shell
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AssetSearchItem, AssetSearchPayload } from "../api/payloads";
import { makeSync } from "../test-helpers";
import { Files } from "./Files";

vi.mock("../api/client", () => ({ apiFetch: vi.fn() }));
vi.mock("../sync/SyncProvider", () => ({ useSync: vi.fn() }));

import { apiFetch } from "../api/client";
import { useSync } from "../sync/SyncProvider";

const mockFetch = vi.mocked(apiFetch);
const mockSync = vi.mocked(useSync);

const item = (over: Partial<AssetSearchItem>): AssetSearchItem => ({
  sha256: "ab".repeat(32), filename: "pic.png", mime: "image/png",
  size: 1234, created_at: 1753000000000,
  url: `/assets/${"ab".repeat(32)}/pic.png`, description: null,
  status: "described", describe_error: null, refs: [], ...over,
});

const payload = (assets: AssetSearchItem[],
                 total = assets.length): AssetSearchPayload =>
  ({ total, assets });

beforeEach(() => {
  vi.clearAllMocks();
  mockSync.mockReturnValue(makeSync("connected"));
  mockFetch.mockResolvedValue(payload([]));
});

describe("Files", () => {
  it("shows the offline note without fetching when disconnected", () => {
    mockSync.mockReturnValue(makeSync("reconnecting"));
    render(<Files />);
    expect(screen.getByText(/needs a connection/i)).toBeInTheDocument();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("shows an empty state", async () => {
    render(<Files />);
    expect(await screen.findByText(/no files match/i)).toBeInTheDocument();
  });

  it("shows an error state when the fetch fails", async () => {
    mockFetch.mockRejectedValue(new Error("boom"));
    render(<Files />);
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
    render(<Files />);
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
    render(<Files />);
    await screen.findByText(/no files match/i);
    for (const name of ["Type", "From", "To", "Linked"]) {
      expect(screen.getByLabelText(name)).toHaveClass("input-control");
    }
    // the search box is the same object as the Cmd-U search, icon and all
    const search = screen.getByLabelText("Search files");
    expect(search).toHaveClass("search-field-input");
    expect(search.closest(".search-field")).not.toBeNull();
  });

  it("passes filters to the search request", async () => {
    render(<Files />);
    await screen.findByText(/no files match/i);
    fireEvent.change(screen.getByLabelText("Type"),
                     { target: { value: "pdf" } });
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("type=pdf")));
    fireEvent.change(screen.getByLabelText("Linked"),
                     { target: { value: "orphan" } });
    await waitFor(() => expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("linked=orphan")));
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
    render(<Files />);
    expect(await screen.findByText("50 of 51 files")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Select all" }));
    await screen.findByText("51 selected");
    expect(mockFetch).toHaveBeenLastCalledWith(
      expect.stringContaining("offset=50"));
  });

  it("deletes selected files after a calm confirm and reports", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    render(<Files />);
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

  it("goes loud when a linked file is selected and survives failures",
     async () => {
    const linked = item({
      refs: [{ uid: "b1", page_title: "AI" }] });
    const other = item({ sha256: "cd".repeat(32), filename: "b.png" });
    mockFetch.mockResolvedValueOnce(payload([linked, other]));
    render(<Files />);
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
    render(<Files />);
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
    render(<Files />);
    fireEvent.click(await screen.findByRole("button",
                                            { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(
      `![pic.png](/assets/${"ab".repeat(32)}/pic.png)`));
    expect(screen.getByText("Link copied.")).toBeInTheDocument();
  });

  it("runs a scan and reports the queue size", async () => {
    mockFetch.mockResolvedValueOnce(payload([]));
    render(<Files />);
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
    render(<Files />);
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
    render(<Files />);
    fireEvent.click(await screen.findByLabelText("Select pic.png"));
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    expect(submit).toHaveBeenCalledOnce();
    submit.mockRestore();
  });

  it("falls back to a type label when the image is broken", async () => {
    mockFetch.mockResolvedValueOnce(payload([item({})]));
    render(<Files />);
    fireEvent.error(await screen.findByRole("img", { name: "pic.png" }));
    expect(screen.getByText("image")).toBeInTheDocument();
  });
});
