import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { parseHelpMarkdown } from "../help/parseHelpMarkdown";
import { Help, HelpBlocks } from "./Help";

it("renders the real doc as the /help page, with a title and a known shortcut row", () => {
  render(<Help />);

  expect(screen.getByRole("heading", { level: 1, name: "Keyboard shortcuts" })).toBeInTheDocument();
  const shortcutCell = screen.getByText(/Go to Daily Notes/);
  expect(shortcutCell.closest("tr")).toHaveTextContent("Ctrl+Shift+D");
  expect(document.title).toBe("Keyboard shortcuts — pkm");
});

it("renders headings, paragraphs, and table rows with inline code spans", () => {
  const md = [
    "# Keyboard shortcuts",
    "",
    "Everything not listed here is native.",
    "",
    "## Anywhere in the app",
    "",
    "| Shortcut | Action |",
    "|---|---|",
    "| Ctrl+Shift+D | Go to Daily Notes |",
    "| Ctrl+O | Open the `[[page]]` the caret is inside |",
  ].join("\n");
  const blocks = parseHelpMarkdown(md);

  render(<HelpBlocks blocks={blocks} />);

  expect(screen.getByRole("heading", { level: 1, name: "Keyboard shortcuts" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 2, name: "Anywhere in the app" })).toBeInTheDocument();
  expect(screen.getByText("Everything not listed here is native.")).toBeInTheDocument();

  const dailyNotesCell = screen.getByText(/Go to Daily Notes/);
  expect(dailyNotesCell.closest("tr")).toHaveTextContent("Ctrl+Shift+D");

  // literal [[page]] is inline code text, not a rendered page link -- Help
  // deliberately doesn't run the doc through the app's link grammar.
  const pageSpan = screen.getByText("[[page]]");
  expect(pageSpan.tagName).toBe("CODE");
  expect(screen.queryByRole("link")).not.toBeInTheDocument();
});
