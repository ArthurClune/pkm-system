import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { jsonResponse } from "../test-helpers";
import { GoodlinksReader } from "./GoodlinksReader";

const ID = "e4966bb2483b5c78f658398c0ae7b03f";
const HREF = `/api/goodlinks/${ID}`;
const ARTICLE = { id: ID, title: "UML My Part", url: "https://tratt.net/uml.html",
                  added_at: "2022-10-06T15:07:12Z", html: "<p>Archived <b>body</b></p>" };

afterEach(() => vi.unstubAllGlobals());

function stub(response: () => Promise<Response>) {
  const mock = vi.fn<typeof fetch>(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

it("fetches the article once and renders bar, meta and a sandboxed iframe", async () => {
  const fetchMock = stub(async () => jsonResponse(ARTICLE));
  render(<GoodlinksReader href={HREF} onClose={vi.fn()} />);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  await waitFor(() => expect(screen.getByTitle("UML My Part")).toBeInTheDocument());
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(String(fetchMock.mock.calls[0][0])).toBe(HREF);
  const frame = screen.getByTitle("UML My Part") as HTMLIFrameElement;
  expect(frame.getAttribute("sandbox")).toBe("allow-popups allow-popups-to-escape-sandbox");
  expect(frame.getAttribute("srcdoc")).toContain("<p>Archived <b>body</b></p>");
  expect(screen.getByRole("link", { name: "original" })).toHaveAttribute("href", ARTICLE.url);
  expect(screen.getByRole("link", { name: "original" })).toHaveAttribute("target", "_blank");
  expect(screen.getByText("saved 6 Oct 2022")).toBeInTheDocument();
  expect(screen.getByRole("dialog")).toHaveAccessibleName("UML My Part");
});

it.each([
  [503, "Goodlinks is not running on the Mac"],
  [404, "No longer in Goodlinks"],
])("status %s shows its note and keeps Close working", async (status, note) => {
  stub(async () => jsonResponse({ detail: "x" }, status));
  const onClose = vi.fn();
  render(<GoodlinksReader href={HREF} onClose={onClose} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(note));
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).toHaveBeenCalledTimes(1);
});

it("a network failure reads as needing the server", async () => {
  stub(async () => { throw new TypeError("Failed to fetch"); });
  render(<GoodlinksReader href={HREF} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Needs the server"));
});

it("Escape closes and focus returns to the trigger", async () => {
  stub(async () => jsonResponse(ARTICLE));
  const onClose = vi.fn();
  const trigger = document.createElement("button");
  document.body.appendChild(trigger);
  const ref = { current: trigger };
  const view = render(<GoodlinksReader href={HREF} onClose={onClose} triggerRef={ref} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toHaveFocus());
  await act(async () => { fireEvent.keyDown(window, { key: "Escape" }); });
  expect(onClose).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("locks body scroll while mounted", async () => {
  stub(async () => jsonResponse(ARTICLE));
  const view = render(<GoodlinksReader href={HREF} onClose={vi.fn()} />);
  expect(document.body.style.overflow).toBe("hidden");
  view.unmount();
  expect(document.body.style.overflow).toBe("");
});
