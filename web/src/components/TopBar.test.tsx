import { act, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { afterEach, expect, it, vi } from "vitest";
import { BlockStampsContext, SidebarContext } from "../contexts";
import { setOfflineGateway } from "../api/client";
import { stubFetch } from "../test-helpers";
import { TopBar } from "./TopBar";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setOfflineGateway(null);
});

function renderTopBar(
  path: string,
  openInSidebar = vi.fn(),
  sidebarCollapsed = false,
  onToggleSidebar = vi.fn(),
) {
  return render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={[path]}>
      <SidebarContext.Provider value={{ openInSidebar }}>
        <TopBar sidebarCollapsed={sidebarCollapsed}
                onToggleSidebar={onToggleSidebar} />
      </SidebarContext.Provider>
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/page/*" element={<p>page view here</p>} />
        {/* catch-all: other paths (e.g. /current-work) are rendered by
            TopBar's own route-labelling logic, not by this test's router;
            without this, react-router logs an unmatched-location warning. */}
        <Route path="*" element={<p>other route</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

it("renders a search bar (a real input, not a button)", () => {
  renderTopBar("/");
  const input = screen.getByRole("textbox", { name: "Search" });
  expect(input).toHaveAttribute("placeholder", "Search…");
  input.focus();
  expect(input).toHaveFocus();
});

it("shows the sidebar toggle before the search bar, labelled to hide an open sidebar", () => {
  renderTopBar("/");
  const toggle = screen.getByRole("button", { name: "Hide sidebar" });
  expect(toggle).toHaveAttribute("aria-expanded", "true");
  const search = screen.getByRole("textbox", { name: "Search" });
  // DOM order backs the "left edge, before search" placement enforced by CSS.
  expect(toggle.compareDocumentPosition(search) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it("reflects a collapsed sidebar with a 'Show sidebar' label and aria-expanded=false", () => {
  renderTopBar("/", vi.fn(), true);
  const button = screen.getByRole("button", { name: "Show sidebar" });
  expect(button).toHaveAttribute("aria-expanded", "false");
});

it("renders svg icons in the sidebar toggle and page menu buttons", () => {
  renderTopBar("/page/AWS");
  expect(screen.getByRole("button", { name: "Hide sidebar" }).querySelector("svg")).not.toBeNull();
  expect(screen.getByRole("button", { name: "Page menu" }).querySelector("svg")).not.toBeNull();
});

it("clicking the sidebar toggle calls onToggleSidebar", () => {
  const onToggleSidebar = vi.fn();
  renderTopBar("/", vi.fn(), false, onToggleSidebar);
  fireEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  expect(onToggleSidebar).toHaveBeenCalledOnce();
});

it("shows no page menu on the journal route", () => {
  renderTopBar("/");
  expect(screen.queryByRole("button", { name: "Page menu" })).toBeNull();
});

it("shows a page menu on a page route", () => {
  renderTopBar("/page/Paper");
  expect(screen.getByRole("button", { name: "Page menu" })).toBeInTheDocument();
});

it("page menu button starts closed and toggles aria-expanded on click", () => {
  renderTopBar("/page/Paper");
  const button = screen.getByRole("button", { name: "Page menu" });
  expect(button).toHaveAttribute("aria-haspopup", "menu");
  expect(button).toHaveAttribute("aria-expanded", "false");

  fireEvent.click(button);
  expect(button).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("menu")).toBeInTheDocument();
  expect(screen.getByRole("menuitem", { name: "Open in sidebar" })).toBeInTheDocument();
});

function stubObjectUrls() {
  const create = vi.fn(() => "blob:fake");
  const revoke = vi.fn();
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = create;
    static revokeObjectURL = revoke;
  });
  return { create, revoke };
}

function exportResponse(): Response {
  return new Response("# md", {
    status: 200,
    headers: {
      "Content-Type": "text/markdown",
      "Content-Disposition": 'attachment; filename="Machine Learning.md"',
    },
  });
}

it("'Export as Markdown' is a button that fetches the page and downloads it", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const urls = stubObjectUrls();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => exportResponse());
  vi.stubGlobal("fetch", fetchMock);
  const downloads: string[] = [];
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click")
    .mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download);
    });
  renderTopBar("/page/Machine Learning");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  const item = screen.getByRole("menuitem", { name: "Export as Markdown" });
  expect(item.tagName).toBe("BUTTON");
  await act(async () => { fireEvent.click(item); });
  expect(fetchMock.mock.calls[0]![0]).toBe("/api/export/page/Machine%20Learning");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(urls.create).toHaveBeenCalledOnce();
  expect(downloads).toEqual(["Machine Learning.md"]);
  expect(urls.revoke).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(59_999); });
  expect(urls.revoke).not.toHaveBeenCalled();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(urls.revoke).toHaveBeenCalledWith("blob:fake");
  expect(screen.queryByRole("alert")).toBeNull();
  click.mockRestore();
  vi.useRealTimers();
});

it("encodes slashes in namespaced page titles for the export fetch", async () => {
  stubObjectUrls();
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => exportResponse());
  vi.stubGlobal("fetch", fetchMock);
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  renderTopBar("/page/AWS/SCP");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Export as Markdown" }));
  });
  expect(fetchMock.mock.calls[0]![0]).toBe("/api/export/page/AWS/SCP");
  click.mockRestore();
});

it("a refused export shows its reason, and a later success clears it", async () => {
  stubObjectUrls();
  let refuse = true;
  vi.stubGlobal("fetch", vi.fn(async () => refuse
    ? new Response(JSON.stringify({ detail: "page too large to export: over 10 million" }),
                   { status: 422 })
    : exportResponse()));
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  renderTopBar("/page/AWS/SCP");
  const exportOnce = async () => {
    fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("menuitem", { name: "Export as Markdown" }));
    });
  };
  await exportOnce();
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent('Couldn\'t export "AWS/SCP": page too large to export');
  expect(alert).not.toHaveTextContent("request failed");
  expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
  refuse = false;
  await exportOnce();
  expect(screen.queryByRole("alert")).toBeNull();
  click.mockRestore();
});

async function exportFromMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("menuitem", { name: "Export as Markdown" }));
  });
}

it("an export attempted offline says so in plain words", async () => {
  stubObjectUrls();
  setOfflineGateway({ offline: () => true, handle: async () => ({ handled: false }) });
  renderTopBar("/page/AWS");
  await exportFromMenu();
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent(
    'Couldn\'t export "AWS": offline: /api/export/page/AWS is unavailable without a connection');
  expect(alert).not.toHaveTextContent("Error:");
});

it("an export that cannot reach the server says so", async () => {
  stubObjectUrls();
  vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
  renderTopBar("/page/AWS");
  await exportFromMenu();
  expect(screen.getByRole("alert")).toHaveTextContent(
    'Couldn\'t export "AWS": couldn\'t reach the server');
});

it("a failure that lands after the user navigated away is dropped", async () => {
  stubObjectUrls();
  let fail: () => void = () => {};
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((_resolve, reject) => {
    fail = () => reject(new TypeError("Failed to fetch"));
  })));
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Paper"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <TopBar sidebarCollapsed={false} onToggleSidebar={vi.fn()} />
      </SidebarContext.Provider>
      <Routes>
        <Route path="/page/*" element={<Link to="/page/Other">go elsewhere</Link>} />
      </Routes>
    </MemoryRouter>,
  );
  await exportFromMenu();
  fireEvent.click(screen.getByRole("link", { name: "go elsewhere" }));
  await act(async () => { fail(); });
  expect(screen.queryByRole("alert")).toBeNull();
});

it("a success that lands after the user navigated away downloads nothing", async () => {
  const urls = stubObjectUrls();
  let finish: () => void = () => {};
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((resolve) => {
    finish = () => resolve(exportResponse());
  })));
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Paper"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <TopBar sidebarCollapsed={false} onToggleSidebar={vi.fn()} />
      </SidebarContext.Provider>
      <Routes>
        <Route path="/page/*" element={<Link to="/page/Other">go elsewhere</Link>} />
      </Routes>
    </MemoryRouter>,
  );
  await exportFromMenu();
  fireEvent.click(screen.getByRole("link", { name: "go elsewhere" }));
  await act(async () => { finish(); });
  expect(urls.create).not.toHaveBeenCalled();
});

it("picking 'Open in sidebar' calls openInSidebar with the current page title and closes the menu", () => {
  const openInSidebar = vi.fn();
  renderTopBar("/page/Machine%20Learning", openInSidebar);
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Open in sidebar" }));

  expect(openInSidebar).toHaveBeenCalledWith("Machine Learning");
  expect(screen.queryByRole("menu")).toBeNull();
});

it("closes the menu on outside click", () => {
  renderTopBar("/page/Paper");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();

  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("menu")).toBeNull();
});

it("closes the menu on Escape", () => {
  renderTopBar("/page/Paper");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  expect(screen.getByRole("menu")).toBeInTheDocument();

  fireEvent.keyDown(document, { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
});

// window.confirm/alert are suppressed by iPadOS Safari in
// standalone/PWA mode -- these exercise the in-app dialog that replaced it
// (a real DOM dialog, not window.confirm, so this also proves the flow
// doesn't depend on a native API iPad silently no-ops).
it("picking 'Delete page…' shows an in-app confirm dialog, and cancelling sends no DELETE", async () => {
  const fetchMock = stubFetch([]);
  renderTopBar("/page/Paper");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));

  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("Paper");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(fetchMock).not.toHaveBeenCalledWith(expect.anything(),
    expect.objectContaining({ method: "DELETE" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByRole("menu")).toBeInTheDocument(); // untouched: nothing happened
});

it("confirming delete in the dialog sends DELETE to the page's URL, closes the menu, and navigates to /", async () => {
  const fetchMock = stubFetch([["/api/page/Machine%20Learning", { ok: true }]]);
  renderTopBar("/page/Machine%20Learning");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));
  await screen.findByRole("alertdialog");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });

  expect(fetchMock).toHaveBeenCalledWith("/api/page/Machine%20Learning",
    expect.objectContaining({ method: "DELETE" }));
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByText("home")).toBeInTheDocument();
});

it("a failed delete closes the menu, does not navigate, and announces an actionable error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ detail: "boom" }), { status: 500 })));
  renderTopBar("/page/Paper");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));
  await screen.findByRole("alertdialog");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });

  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByText("page view here")).toBeInTheDocument();
  expect(screen.queryByText("home")).toBeNull();

  // role="alert" is how the sync banner and upload errors announce failures
  // elsewhere in the app -- the same pattern, not a new one.
  const alert = screen.getByRole("alert");
  expect(alert).toHaveTextContent("Paper");
  expect(alert).toHaveTextContent("boom");
});

it("dismissing the delete error removes it", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ detail: "boom" }), { status: 500 })));
  renderTopBar("/page/Paper");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));
  await screen.findByRole("alertdialog");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });
  expect(screen.getByRole("alert")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
  expect(screen.queryByRole("alert")).toBeNull();
});

it("retrying a failed delete clears the stale error and navigates on success", async () => {
  // Previews fail (plain confirm fallback); only the DELETEs are sequenced.
  const deletes = [
    new Response(JSON.stringify({ detail: "boom" }), { status: 500 }),
    new Response(JSON.stringify({ ok: true }), { status: 200 }),
  ];
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => (
    init?.method === "DELETE"
      ? deletes.shift()!
      : new Response(JSON.stringify({ detail: "no" }), { status: 500 })));
  vi.stubGlobal("fetch", fetchMock);
  renderTopBar("/page/Paper");
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));
  await screen.findByRole("alertdialog");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });
  expect(screen.getByRole("alert")).toBeInTheDocument();

  // Reopen the menu and try again -- the stale error from the first
  // attempt must not linger once a new attempt is under way, and a
  // successful retry must navigate exactly like a first-try success.
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));
  await screen.findByRole("alertdialog");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });

  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("home")).toBeInTheDocument();
  expect(deletes).toHaveLength(0);
});

it("navigating away clears a stale delete error", async () => {
  vi.stubGlobal("fetch", vi.fn(async () =>
    new Response(JSON.stringify({ detail: "boom" }), { status: 500 })));
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/Paper"]}>
      <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
        <TopBar sidebarCollapsed={false} onToggleSidebar={vi.fn()} />
      </SidebarContext.Provider>
      <Routes>
        <Route path="/page/*" element={<><p>page view here</p><Link to="/page/Other">go elsewhere</Link></>} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));
  await screen.findByRole("alertdialog");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });
  expect(screen.getByRole("alert")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("link", { name: "go elsewhere" }));

  expect(screen.queryByRole("alert")).toBeNull();
});

const NO_BLOCKERS = { links: 0, link_pages: 0, block_refs: 0, block_ref_pages: 0, blockers: [] };
const BLOCKERS = {
  ...NO_BLOCKERS,
  blockers: [
    { uid: "u1", page_title: "Queries", excerpt: "{{query: [[Paper]]}}", text_length: 20,
      reason: "query" },
    { uid: "u2", page_title: "Notes/Sub", excerpt: "Paper:: x", text_length: 9, reason: "attribute" },
  ],
};

async function openDelete(path = "/page/Paper") {
  renderTopBar(path);
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete page…" }));
}

it("a preview with blockers shows the blocked dialog and never sends DELETE", async () => {
  const fetchMock = stubFetch([["/api/delete-preview", BLOCKERS]]);
  await openDelete();
  const dialog = await screen.findByRole("dialog", { name: 'Can\'t delete "Paper"' });
  expect(dialog).toHaveTextContent("Change these blocks first:");
  expect(dialog).toHaveTextContent("a query names this page");
  expect(dialog).toHaveTextContent("unlinking would make this an attribute");
  expect(dialog).toHaveTextContent("Notes/Sub: Paper:: x (unlinking would make this an attribute)");
  expect(screen.getByRole("link", { name: "Queries" })).toHaveAttribute("href", "/page/Queries");
  expect(screen.getByRole("link", { name: "Notes/Sub" })).toHaveAttribute("href", "/page/Notes/Sub");
  expect(screen.queryByRole("alertdialog")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalledWith(expect.anything(),
    expect.objectContaining({ method: "DELETE" }));
});

it("a preview without blockers shows the counted confirm and DELETEs on confirm", async () => {
  const fetchMock = stubFetch([
    ["/api/delete-preview", { ...NO_BLOCKERS, links: 2, link_pages: 1 }],
    ["/api/page/Paper", { ok: true }],
  ]);
  await openDelete();
  const dialog = await screen.findByRole("alertdialog");
  expect(dialog).toHaveTextContent("2 links on 1 page will become plain text.");
  expect(fetchMock).toHaveBeenCalledWith("/api/delete-preview?title=Paper", expect.anything());
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });
  expect(fetchMock).toHaveBeenCalledWith("/api/page/Paper",
    expect.objectContaining({ method: "DELETE" }));
  expect(screen.getByText("home")).toBeInTheDocument();
});

it("a 409 from DELETE re-fetches the preview and shows the blocked dialog", async () => {
  let previews = 0;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/delete-preview")) {
      previews += 1;
      return new Response(JSON.stringify(previews === 1 ? NO_BLOCKERS : BLOCKERS), { status: 200 });
    }
    if (init?.method === "DELETE") {
      return new Response(JSON.stringify({ detail: "blocked" }), { status: 409 });
    }
    return new Response("{}", { status: 404 });
  }));
  await openDelete();
  await screen.findByRole("alertdialog");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });
  expect(await screen.findByRole("dialog", { name: 'Can\'t delete "Paper"' })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("page view here")).toBeInTheDocument();
});

it("a 409 whose re-fetched preview has no blockers falls back to the error line", async () => {
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("/api/delete-preview")) {
      return new Response(JSON.stringify(NO_BLOCKERS), { status: 200 });
    }
    return new Response(JSON.stringify({ detail: "blocked" }), {
      status: init?.method === "DELETE" ? 409 : 404 });
  }));
  await openDelete();
  await screen.findByRole("alertdialog");
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  });
  expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't delete \"Paper\"");
});

it("the blocked dialog closes on Escape", async () => {
  stubFetch([["/api/delete-preview", BLOCKERS]]);
  await openDelete();
  await screen.findByRole("dialog", { name: 'Can\'t delete "Paper"' });
  expect(screen.getByRole("button", { name: "Close" })).toHaveFocus();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("shows the current page title in the bar on page routes", () => {
  renderTopBar("/page/AWS/SCP");
  const label = screen.getByText("AWS/SCP");
  expect(label).toHaveClass("top-bar-title");
});

it("labels the journal route 'Daily Notes' in the bar", () => {
  renderTopBar("/");
  expect(screen.getByText("Daily Notes")).toHaveClass("top-bar-title");
});

it("labels the current-work route in the bar", () => {
  renderTopBar("/current-work");
  expect(screen.getByText("Current Work")).toHaveClass("top-bar-title");
});

// /files and /settings need their own route-label coverage: they exist in
// the router but only get a top-bar label from centralized route metadata.
it("labels the files route in the bar", () => {
  renderTopBar("/files");
  expect(screen.getByText("Files")).toHaveClass("top-bar-title");
});

it("labels the settings route in the bar", () => {
  renderTopBar("/settings");
  expect(screen.getByText("Settings")).toHaveClass("top-bar-title");
});

it("shows the search shortcut hint inside the search pill", () => {
  const { container } = renderTopBar("/");
  const hint = container.querySelector("kbd.top-bar-search-hint");
  expect(hint).not.toBeNull();
  expect(hint!.textContent).toMatch(/U$/);
});

function renderTopBarWithStamps(stamps: boolean, toggle = vi.fn()) {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/AWS"]}>
      <BlockStampsContext.Provider value={{ stamps, toggle }}>
        <SidebarContext.Provider value={{ openInSidebar: vi.fn() }}>
          <TopBar sidebarCollapsed={false} onToggleSidebar={vi.fn()} />
        </SidebarContext.Provider>
      </BlockStampsContext.Provider>
      <Routes>
        <Route path="/page/*" element={<p>page view here</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return { toggle };
}

// The label carries the state, so it names the action available now, not the
// state you are in: off -> "Show timestamps", on -> "Hide timestamps".
// Asserting the opposite label is absent is the part that matters -- a reserved
// checkmark slot would leave both readings plausible.
it("labels the timestamps item 'Show timestamps' when the preference is off", () => {
  renderTopBarWithStamps(false);
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  expect(screen.getByRole("menuitem", { name: "Show timestamps" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Hide timestamps" })).toBeNull();
});

it("labels the timestamps item 'Hide timestamps' when the preference is on", () => {
  renderTopBarWithStamps(true);
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  expect(screen.getByRole("menuitem", { name: "Hide timestamps" })).toBeInTheDocument();
  expect(screen.queryByRole("menuitem", { name: "Show timestamps" })).toBeNull();
});

it("flipping the item toggles the preference and leaves the menu open", () => {
  const { toggle } = renderTopBarWithStamps(false);
  fireEvent.click(screen.getByRole("button", { name: "Page menu" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Show timestamps" }));
  expect(toggle).toHaveBeenCalledTimes(1);
  // A setting, not a destination: closing the menu on every flip would make
  // "try it and put it back" a four-click round trip. (The label stays "Show"
  // here only because `toggle` is a mock -- the preference never changes.)
  expect(screen.getByRole("menuitem", { name: "Show timestamps" })).toBeInTheDocument();
});

it("does not offer the timestamps item off /page/* routes", () => {
  renderTopBar("/current-work");
  expect(screen.queryByRole("button", { name: "Page menu" })).toBeNull();
});
