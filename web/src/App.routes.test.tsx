// Every main-pane route as users reach it: the view a path renders, its
// top-bar label and its browser title. Literal strings throughout.
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { expect, it, vi } from "vitest";
import { MainRoutes } from "./App";
import { routeMetaFor } from "./routeMeta";
import { useRouteTitle } from "./useRouteTitle";

vi.mock("./views/Journal", () => ({ Journal: () => <p>view:journal</p> }));
vi.mock("./views/CurrentWork",
        () => ({ CurrentWork: () => <p>view:currentWork</p> }));
vi.mock("./views/Help", () => ({ Help: () => <p>view:help</p> }));
vi.mock("./views/Files", () => ({ Files: () => <p>view:files</p> }));
vi.mock("./views/Settings", () => ({ Settings: () => <p>view:settings</p> }));
vi.mock("./views/PageView", () => ({ PageView: () => <p>view:page</p> }));

function Main() {
  useRouteTitle();
  return <MainRoutes />;
}

function renderAt(path: string) {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Main />
    </MemoryRouter>);
}

it.each([
  ["/", "journal", "Daily Notes", "Daily Notes — pkm"],
  ["/current-work", "currentWork", "Current Work", "Current Work — pkm"],
  ["/help", "help", "Help", "Keyboard shortcuts — pkm"],
  ["/files", "files", "Files", "Files — pkm"],
  ["/files/", "files", "Files", "Files — pkm"],
  ["/settings", "settings", "Settings", "Settings — pkm"],
])("%s renders %s, labelled %s, titled %s",
   (path, view, label, documentTitle) => {
  document.title = "before";
  renderAt(path);
  expect(screen.getByText(`view:${view}`)).toBeInTheDocument();
  expect(routeMetaFor(path)?.label).toBe(label);
  expect(document.title).toBe(documentTitle);
});

it("/page/... renders the page view, which owns its label and title", () => {
  document.title = "Paper — pkm";
  renderAt("/page/Paper");
  expect(screen.getByText("view:page")).toBeInTheDocument();
  expect(routeMetaFor("/page/Paper")).toBeUndefined();
  expect(document.title).toBe("Paper — pkm");
});

it("any other path renders the not-found view, with no label", () => {
  renderAt("/no/such/route");
  expect(screen.getByRole("heading", { name: "Page not found" }))
    .toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Go to Daily Notes" }))
    .toHaveAttribute("href", "/");
  expect(routeMetaFor("/no/such/route")).toBeUndefined();
});
