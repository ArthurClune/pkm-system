import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { Settings } from "./Settings";

it("renders a Settings title and a whole-database export download link (pkm-7myl)", () => {
  render(<Settings />);

  expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();
  expect(document.title).toBe("Settings — pkm");

  const link = screen.getByRole("link", { name: /export.*markdown/i });
  expect(link).toHaveAttribute("href", "/api/export.zip");
  expect(link).toHaveAttribute("download");

  // the export is slow to start on large databases (assets are bundled and
  // the zip is built server-side first) -- the page must say so
  expect(screen.getByText(/can take a minute or more/i)).toBeInTheDocument();
});

it("structures settings as a list of sections so more items can be added later", () => {
  render(<Settings />);

  // one section today ("Export"); more will land as siblings, not as a
  // one-off special case -- see pkm-7myl.
  const sections = document.querySelectorAll(".settings-section");
  expect(sections.length).toBeGreaterThanOrEqual(1);
  expect(screen.getByRole("heading", { level: 2, name: "Export" })).toBeInTheDocument();
});
