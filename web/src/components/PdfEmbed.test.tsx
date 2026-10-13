import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

// The real PdfViewer drags react-pdf/pdfjs into jsdom; substitute a marker.
vi.mock("./PdfViewer", () => ({
  PdfViewer: ({ href, label }: { href: string; label: string }) => (
    <div data-testid="pdf-viewer">{label}:{href}</div>
  ),
}));

import { PdfEmbed } from "./PdfEmbed";

const href = `/assets/${"ab".repeat(32)}/doc.pdf`;

it("shows the plain link while loading, then swaps in the viewer", async () => {
  render(<PdfEmbed href={href} label="Notes" />);
  // synchronous first paint: the fallback link (never a blank slot)
  expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", href);
  await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());
  expect(screen.getByTestId("pdf-viewer")).toHaveTextContent(`Notes:${href}`);
});

it("serves a second instance from the cached chunk once the first has loaded", async () => {
  render(<PdfEmbed href={href} label="First" />);
  await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());
  // second mount hits the already-resolved module-level viewerPromise
  render(<PdfEmbed href={href} label="Second" />);
  await waitFor(() => expect(screen.getAllByTestId("pdf-viewer")).toHaveLength(2));
  expect(screen.getAllByTestId("pdf-viewer")[1]).toHaveTextContent(`Second:${href}`);
});

it("keeps the link fallback with a note when the viewer chunk fails", async () => {
  vi.resetModules();
  vi.doMock("./PdfViewer", () => {
    throw new Error("chunk load failed");
  });
  const { PdfEmbed: FreshPdfEmbed } = await import("./PdfEmbed");
  render(<FreshPdfEmbed href={href} label="Notes" />);
  await waitFor(() =>
    expect(screen.getByText("Couldn't load the PDF viewer.")).toBeInTheDocument());
  expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", href);
  vi.doUnmock("./PdfViewer");
  vi.resetModules();
});

it("deferred: shows the link and an Open button, mounting nothing until clicked", async () => {
  render(<PdfEmbed href={href} label="Notes" deferred />);
  expect(screen.getByRole("link", { name: "Notes" })).toHaveAttribute("href", href);
  const open = screen.getByRole("button", { name: "Open" });
  // give a pending viewer import (if one were wrongly started) time to settle
  await act(async () => {});
  expect(screen.queryByTestId("pdf-viewer")).toBeNull();

  fireEvent.click(open);
  await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());
  expect(screen.getByTestId("pdf-viewer")).toHaveTextContent(`Notes:${href}`);
  expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
});

it("deferred: the Open click does not bubble to the block (which would re-enter edit mode)", () => {
  const onParentClick = vi.fn();
  render(
    <div onClick={onParentClick}>
      <PdfEmbed href={href} label="Notes" deferred />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(onParentClick).not.toHaveBeenCalled();
});

it("not deferred: no Open button, the viewer mounts on its own", async () => {
  render(<PdfEmbed href={href} label="Notes" />);
  expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  await waitFor(() => expect(screen.getByTestId("pdf-viewer")).toBeInTheDocument());
});

// ---- local-copy download probe ----------------------------------------

const localHref = "/api/local/Papers/doc.pdf";
const NOT_FOUND = "This file isn't in the local documents folder on the host.";
const UNAVAILABLE = "The host can't serve this file right now: it isn't downloaded yet, or the host isn't allowed to read it.";

function stubFetch(impl: () => Promise<Response>) {
  const f = vi.fn(impl);
  vi.stubGlobal("fetch", f);
  return f;
}

// Programmatic downloads go through a temporary anchor's click().
function spyDownloads() {
  const downloaded: string[] = [];
  const spy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
    if (this.hasAttribute("download")) downloaded.push(this.getAttribute("href") ?? "");
  });
  return { downloaded, spy };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("local copy: a 404 shows the not-found note and downloads nothing", async () => {
  const f = stubFetch(async () => new Response('{"detail":"not found"}', { status: 404 }));
  const { downloaded } = spyDownloads();
  render(<PdfEmbed href={localHref} label="Notes" deferred />);
  fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  expect(await screen.findByText(NOT_FOUND)).toHaveClass("pdf-error-note");
  expect(f).toHaveBeenCalledWith(localHref, expect.objectContaining({ headers: { Range: "bytes=0-0" } }));
  expect(downloaded).toEqual([]);
});

it("local copy: a 503 shows the host-can't-serve note", async () => {
  stubFetch(async () => new Response("{}", { status: 503 }));
  const { downloaded } = spyDownloads();
  render(<PdfEmbed href={localHref} label="Notes" deferred />);
  fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  expect(await screen.findByText(UNAVAILABLE)).toBeInTheDocument();
  expect(downloaded).toEqual([]);
});

it("local copy: a rejected fetch shows the unreachable note", async () => {
  stubFetch(async () => {
    throw new TypeError("offline");
  });
  const { downloaded } = spyDownloads();
  render(<PdfEmbed href={localHref} label="Notes" deferred />);
  fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  expect(await screen.findByText("Couldn't reach the host to fetch this file.")).toBeInTheDocument();
  expect(downloaded).toEqual([]);
});

it.each([200, 206])("local copy: a %i downloads the file and shows no note", async (status) => {
  stubFetch(async () => new Response("x", { status }));
  const { downloaded } = spyDownloads();
  const { container } = render(<PdfEmbed href={localHref} label="Notes" deferred />);
  fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  await waitFor(() => expect(downloaded).toEqual([localHref]));
  expect(container.querySelector(".pdf-error-note")).toBeNull();
});

it("local copy: the click is held back from the native download while probing", () => {
  stubFetch(() => new Promise(() => {}));
  render(<PdfEmbed href={localHref} label="Notes" deferred />);
  const notPrevented = fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  expect(notPrevented).toBe(false);
});

it("local copy: the link click does not bubble to the block", () => {
  stubFetch(() => new Promise(() => {}));
  const onParentClick = vi.fn();
  render(
    <div onClick={onParentClick}>
      <PdfEmbed href={localHref} label="Notes" deferred />
    </div>,
  );
  fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  expect(onParentClick).not.toHaveBeenCalled();
});

it("local copy: a second tap while a probe is in flight does not probe again", async () => {
  const f = stubFetch(() => new Promise(() => {}));
  render(<PdfEmbed href={localHref} label="Notes" deferred />);
  const link = screen.getByRole("link", { name: "Notes" });
  fireEvent.click(link);
  fireEvent.click(link);
  expect(f).toHaveBeenCalledTimes(1);
});

it("local copy: a later successful tap clears the earlier note", async () => {
  let status = 404;
  stubFetch(async () => new Response("x", { status }));
  const { downloaded } = spyDownloads();
  render(<PdfEmbed href={localHref} label="Notes" deferred />);
  fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  await screen.findByText(NOT_FOUND);
  status = 206;
  fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  await waitFor(() => expect(downloaded).toEqual([localHref]));
  expect(screen.queryByText(NOT_FOUND)).toBeNull();
});

it("asset href: no probe, the native download link is left alone", () => {
  const f = stubFetch(async () => new Response("x"));
  render(<PdfEmbed href={href} label="Notes" deferred />);
  let prevented: boolean | null = null;
  const record = (e: Event) => {
    prevented = e.defaultPrevented;
    e.preventDefault(); // keep jsdom from attempting navigation
  };
  document.addEventListener("click", record);
  fireEvent.click(screen.getByRole("link", { name: "Notes" }));
  document.removeEventListener("click", record);
  expect(prevented).toBe(false);
  expect(f).not.toHaveBeenCalled();
});
