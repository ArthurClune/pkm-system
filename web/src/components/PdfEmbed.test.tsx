import { render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

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
