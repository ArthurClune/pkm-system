import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { PdfFallbackLink } from "./PdfFallbackLink";

const href = `/assets/${"ab".repeat(32)}/doc.pdf`;

it("renders a download link using the label", () => {
  render(<PdfFallbackLink href={href} label="Notes" />);
  const link = screen.getByRole("link", { name: "Notes" });
  expect(link).toHaveAttribute("href", href);
  expect(link).toHaveAttribute("download");
});

it("falls back to generic text when the label is empty", () => {
  render(<PdfFallbackLink href={href} label="" />);
  expect(screen.getByRole("link", { name: "Download PDF" })).toBeInTheDocument();
});

it("renders no note element when the note is empty", () => {
  const { container } = render(<PdfFallbackLink href={href} label="Notes" note="" />);
  expect(container.querySelector(".pdf-error-note")).toBeNull();
});

it("renders the note above the download link", () => {
  const { container } = render(
    <PdfFallbackLink href={href} label="Notes" note="Couldn't render this PDF." />,
  );
  const children = Array.from(container.querySelector(".pdf-embed")!.children);
  expect(children.map((c) => c.className)).toEqual(["pdf-error-note", "pdf-download"]);
});

it("shows the note only when given", () => {
  const { rerender } = render(<PdfFallbackLink href={href} label="Notes" />);
  expect(screen.queryByText("Couldn't render this PDF.")).toBeNull();
  rerender(<PdfFallbackLink href={href} label="Notes" note="Couldn't render this PDF." />);
  expect(screen.getByText("Couldn't render this PDF.")).toBeInTheDocument();
});
