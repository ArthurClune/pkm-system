// What a user's browser already holds for the two stored on/off preferences.
// Literal strings throughout, never the constants: a build that reads or
// writes other strings silently resets every user's choice.
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { block, canonicalTitleOf, pagePayload, stubFetch } from "./test-helpers";
import { App } from "./App";

class NoopObserver {
  constructor(_cb: IntersectionObserverCallback) {}
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
  root = null;
  rootMargin = "";
  thresholds: number[] = [];
}

beforeEach(() => vi.stubGlobal("IntersectionObserver", NoopObserver));
afterEach(() => vi.unstubAllGlobals());

async function renderPage() {
  stubFetch([
    ["/api/page/Paper", pagePayload(canonicalTitleOf("Paper"),
                                    [block("uid_s1", "paper body")])],
  ]);
  const view = render(
    <MemoryRouter
                  initialEntries={["/page/Paper"]}><App /></MemoryRouter>);
  expect(await screen.findByText("paper body")).toBeInTheDocument();
  return view;
}

const toggleStamps = () =>
  fireEvent.keyDown(window, { key: "t", ctrlKey: true, shiftKey: true });

it("the stored strings are the ones earlier builds wrote", async () => {
  await renderPage();
  expect(localStorage.getItem("pkm:sidebar")).toBe("open");
  expect(localStorage.getItem("pkm:block-stamps")).toBe("off");

  fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  toggleStamps();
  expect(localStorage.getItem("pkm:sidebar")).toBe("collapsed");
  expect(localStorage.getItem("pkm:block-stamps")).toBe("on");

  fireEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  toggleStamps();
  expect(localStorage.getItem("pkm:sidebar")).toBe("open");
  expect(localStorage.getItem("pkm:block-stamps")).toBe("off");
});

it("stored 'collapsed' and 'on' load as a collapsed sidebar and stamps",
   async () => {
  localStorage.setItem("pkm:sidebar", "collapsed");
  localStorage.setItem("pkm:block-stamps", "on");
  const { container } = await renderPage();

  expect(screen.getByRole("navigation")).toHaveClass("collapsed");
  expect(container.querySelector(".block-stamp")).not.toBeNull();
  expect(localStorage.getItem("pkm:sidebar")).toBe("collapsed");
  expect(localStorage.getItem("pkm:block-stamps")).toBe("on");
});

it("an unknown stored string reads as the default and is overwritten",
   async () => {
  localStorage.setItem("pkm:sidebar", "hidden");
  localStorage.setItem("pkm:block-stamps", "yes");
  const { container } = await renderPage();

  expect(screen.getByRole("navigation")).not.toHaveClass("collapsed");
  expect(container.querySelector(".block-stamp")).toBeNull();
  expect(localStorage.getItem("pkm:sidebar")).toBe("open");
  expect(localStorage.getItem("pkm:block-stamps")).toBe("off");
});

it("storage that throws gives the defaults, and the toggles still work",
   async () => {
  const fail = () => { throw new DOMException("denied", "SecurityError"); };
  vi.stubGlobal("localStorage", {
    getItem: fail, setItem: fail, removeItem: fail, clear: fail,
  });
  const { container } = await renderPage();
  const nav = screen.getByRole("navigation");
  expect(nav).not.toHaveClass("collapsed");
  expect(container.querySelector(".block-stamp")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  toggleStamps();

  expect(nav).toHaveClass("collapsed");
  expect(container.querySelector(".block-stamp")).not.toBeNull();
});
