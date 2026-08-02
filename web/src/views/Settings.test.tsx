import { render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { apiFetch } from "../api/client";
import { Settings } from "./Settings";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});
const apiFetchMock = vi.mocked(apiFetch);

beforeEach(() => {
  apiFetchMock.mockReset();
  // default: never resolves -- tests that don't care about the status
  // section shouldn't need to stub it themselves.
  apiFetchMock.mockReturnValue(new Promise(() => {}));
});

// The browser title is set by the centralized route-title effect
// (useRouteTitle, pkm-77w2), not by this component -- see
// useRouteTitle.test.tsx for that coverage.
it("renders a Settings title and a whole-database export download link (pkm-7myl)", () => {
  render(<Settings />);

  expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeInTheDocument();

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

it("shows image descriptions enabled", async () => {
  apiFetchMock.mockResolvedValue({ enabled: true, reason: null });
  render(<Settings />);

  expect(await screen.findByText(/image descriptions/i)).toBeInTheDocument();
  expect(await screen.findByText(/enabled/i)).toBeInTheDocument();
  expect(apiFetchMock).toHaveBeenCalledWith(
    "/api/assets/describe-status", { method: "GET" });
});

it("shows the disabled reason", async () => {
  apiFetchMock.mockResolvedValue({ enabled: false, reason: "OPENAI_API_KEY is not set" });
  render(<Settings />);

  expect(await screen.findByText(/OPENAI_API_KEY is not set/)).toBeInTheDocument();
});

it("stays quiet when the status fetch fails", async () => {
  apiFetchMock.mockRejectedValue(new Error("network error"));
  render(<Settings />);

  expect(await screen.findByText(/unavailable/i)).toBeInTheDocument();
});
