import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { stubFetch } from "../test-helpers";
import { SearchModal } from "./SearchModal";

afterEach(() => vi.unstubAllGlobals());

const results = {
  pages: [{ id: 4, title: "Paper" }],
  blocks: [{ uid: "uid_b3", page_title: "Machine Learning",
             snippet: "a <mark>paper</mark> about attention" }],
};

function renderModal(onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={["/"]}>
      <SearchModal open={true} onClose={onClose} />
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/page/*" element={<p>page view here</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

it("debounces input, lists pages before block snippets with real <mark>s", async () => {
  const fetchMock = stubFetch([["/api/search?q=paper", results]]);
  renderModal();
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "pap" } });
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "pape" } });
  fireEvent.change(screen.getByPlaceholderText("Search…"), { target: { value: "paper" } });
  const items = await screen.findAllByRole("listitem");
  expect(fetchMock).toHaveBeenCalledTimes(1); // only the settled query fired
  expect(items[0].textContent).toContain("Paper");           // page hit first
  expect(items[1].textContent).toContain("Machine Learning"); // then block hit
  const mark = items[1].querySelector("mark");
  expect(mark).not.toBeNull();
  expect(mark!.textContent).toBe("paper");
});

it("Enter navigates to the selected hit and closes", async () => {
  stubFetch([["/api/search?q=paper", results]]);
  const onClose = renderModal();
  const input = screen.getByPlaceholderText("Search…");
  fireEvent.change(input, { target: { value: "paper" } });
  await screen.findAllByRole("listitem");
  fireEvent.keyDown(input, { key: "ArrowDown" });
  fireEvent.keyDown(input, { key: "Enter" });
  expect(onClose).toHaveBeenCalled();
  expect(screen.getByText("page view here")).toBeInTheDocument();
});

it("Escape closes without navigating", () => {
  stubFetch([]);
  const onClose = renderModal();
  fireEvent.keyDown(screen.getByPlaceholderText("Search…"), { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});
