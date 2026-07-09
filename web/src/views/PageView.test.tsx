import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, expect, it, vi } from "vitest";
import { block, pagePayload, stubFetch } from "../test-helpers";
import { PageView } from "./PageView";

afterEach(() => vi.unstubAllGlobals());

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/page/*" element={<PageView />} />
      </Routes>
    </MemoryRouter>,
  );
}

it("fetches and renders a page, resolving block refs from the payload", async () => {
  const fetchMock = stubFetch([
    ["/api/page/Generative%20Models", pagePayload("Generative Models", [
      block("uid_p1", "intro [[Paper]]"),
      block("uid_p2", "See ((uid_r1))"),
    ], { block_ref_texts: { uid_r1: { text: "the referenced text", page_title: "Paper" } } })],
  ]);
  renderAt("/page/Generative%20Models");
  expect(await screen.findByRole("heading", { name: "Generative Models" })).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Paper" })).toBeInTheDocument();
  expect(screen.getByText("the referenced text")).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/page/Generative%20Models", undefined);
});

it("keeps literal slashes in namespace titles", async () => {
  const fetchMock = stubFetch([
    ["/api/page/AWS/SCP", pagePayload("AWS/SCP", [block("uid_n1", "scp notes")])],
  ]);
  renderAt("/page/AWS/SCP");
  expect(await screen.findByRole("heading", { name: "AWS/SCP" })).toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledWith("/api/page/AWS/SCP", undefined);
});

it("shows an error state on 404", async () => {
  stubFetch([]);
  renderAt("/page/Nope");
  expect(await screen.findByText(/could not load/i)).toBeInTheDocument();
});
