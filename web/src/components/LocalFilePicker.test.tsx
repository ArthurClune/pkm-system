import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { jsonResponse } from "../test-helpers";
import { LocalFilePicker } from "./LocalFilePicker";

const FILES = [
  { path: "root.txt", href: "/local/root.txt" },
  { path: "Papers/intro.pdf", href: "/local/Papers/intro.pdf" },
  { path: "Papers/Machine Learning/Deep.pdf", href: "/local/Papers/Machine%20Learning/Deep.pdf" },
  { path: "Papers/Machine Learning/Notes.md", href: "/local/Papers/Machine%20Learning/Notes.md" },
];

afterEach(() => vi.unstubAllGlobals());

function stub(response: () => Promise<Response>) {
  const mock = vi.fn<typeof fetch>(response);
  vi.stubGlobal("fetch", mock);
  return mock;
}

function stubIndex(files = FILES) {
  return stub(async () => jsonResponse({ files }));
}

async function open(props: { onPick?: () => void; onClose?: () => void } = {}) {
  const onPick = props.onPick ?? vi.fn();
  const onClose = props.onClose ?? vi.fn();
  render(<LocalFilePicker onPick={onPick} onClose={onClose} />);
  await screen.findByRole("listbox");
  return { onPick, onClose };
}

const box = () => screen.getByRole("combobox", { name: "Search local files" });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const press = (key: string) => fireEvent.keyDown(box(), { key });
const click = (el: HTMLElement) => fireEvent.click(el);

const optionNames = () => screen.getAllByRole("option").map((o) => o.textContent);

it("browses folders from the root and back up via the breadcrumb", async () => {
  stubIndex();
  await open();
  expect(screen.getByRole("dialog")).toHaveAccessibleName("Link a local file");
  expect(optionNames()).toEqual(["Papers", "root.txt"]);
  click(screen.getByRole("option", { name: "Papers" }));
  const crumbs = within(screen.getByRole("navigation", { name: "Folder" }));
  expect(crumbs.getAllByRole("button").map((b) => b.textContent)).toEqual(["pkm", "Papers"]);
  expect(optionNames()).toEqual(["Machine Learning", "intro.pdf"]);
  click(screen.getByRole("option", { name: "Machine Learning" }));
  expect(optionNames()).toEqual(["Deep.pdf", "Notes.md"]);
  click(crumbs.getByRole("button", { name: "Papers" }));
  expect(optionNames()).toEqual(["Machine Learning", "intro.pdf"]);
  click(crumbs.getByRole("button", { name: "pkm" }));
  expect(optionNames()).toEqual(["Papers", "root.txt"]);
});

it("typing searches the whole tree and shows each result's folder", async () => {
  stubIndex();
  await open();
  type("deep");
  const rows = screen.getAllByRole("option");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toHaveTextContent("Deep.pdf");
  expect(rows[0]).toHaveTextContent("Papers › Machine Learning");
  expect(screen.queryByRole("navigation", { name: "Folder" })).not.toBeInTheDocument();
});

it("highlights matched runs in the name and in the folder, mapped past the › separators", async () => {
  stubIndex();
  await open();
  type("learning deep");
  const marks = [...screen.getByRole("option").querySelectorAll("mark")].map((m) => m.textContent);
  expect(marks.join("").toLowerCase()).toContain("deep");
  expect(marks.join("").toLowerCase()).toContain("learning");
  for (const m of marks) expect("deeplearning").toContain((m ?? "").toLowerCase());
});

it("a match in the second folder segment highlights that segment's text", async () => {
  stubIndex([{ path: "aaa/bbb/ccc/x.pdf", href: "/local/x" }]);
  await open();
  type("ccc");
  const row = screen.getByRole("option");
  expect([...row.querySelectorAll("mark")].map((m) => m.textContent)).toEqual(["ccc"]);
  expect(row).toHaveTextContent("aaa › bbb › ccc");
});

it("clearing the search returns to the folder being browsed", async () => {
  stubIndex();
  await open();
  click(screen.getByRole("option", { name: "Papers" }));
  type("root");
  expect(optionNames()).toEqual(["root.txt"]);
  type("");
  expect(optionNames()).toEqual(["Machine Learning", "intro.pdf"]);
});

it("ArrowDown then Enter picks the selected file; clicking a file picks it", async () => {
  stubIndex();
  const { onPick } = await open();
  expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  press("ArrowDown");
  expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  press("ArrowDown");
  expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
  expect(box()).toHaveFocus();
  press("Enter");
  expect(onPick).toHaveBeenCalledWith(FILES[0]);
  click(screen.getByRole("option", { name: "root.txt" }));
  expect(onPick).toHaveBeenCalledTimes(2);
});

it("Enter on a folder opens it, ArrowUp clamps, and the selection resets to the first row", async () => {
  stubIndex();
  const { onPick } = await open();
  press("ArrowUp");
  expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  press("ArrowDown"); press("ArrowUp"); press("Enter");
  expect(onPick).not.toHaveBeenCalled();
  expect(optionNames()).toEqual(["Machine Learning", "intro.pdf"]);
  expect(screen.getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
});

it("Escape and a backdrop click close without picking", async () => {
  stubIndex();
  const { onPick, onClose } = await open();
  press("Escape");
  expect(onClose).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("dialog"));
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(onPick).not.toHaveBeenCalled();
});

it("a click inside the panel does not close", async () => {
  stubIndex();
  const { onClose } = await open();
  fireEvent.click(screen.getByRole("listbox"));
  expect(onClose).not.toHaveBeenCalled();
});

it("fetches the index once, with focus in the search box", async () => {
  const mock = stubIndex();
  await open();
  expect(mock).toHaveBeenCalledTimes(1);
  expect(String(mock.mock.calls[0][0])).toBe("/api/local-index");
  expect(box()).toHaveFocus();
});

it("shows Loading… until the index arrives", async () => {
  stubIndex();
  render(<LocalFilePicker onPick={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByRole("status")).toHaveTextContent("Loading…");
  await screen.findByRole("listbox");
});

it.each([
  [404, "Local files aren't set up on this server"],
  [503, "Couldn't read the local files folder on the server"],
  [500, "Couldn't reach the server"],
])("status %s shows its message", async (status, message) => {
  stub(async () => jsonResponse({ detail: "x" }, status));
  render(<LocalFilePicker onPick={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
  expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
});

it("a fetch rejection shows the unreachable message", async () => {
  stub(async () => { throw new TypeError("Failed to fetch"); });
  render(<LocalFilePicker onPick={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("Couldn't reach the server"));
});

it("an empty index shows No files", async () => {
  stubIndex([]);
  render(<LocalFilePicker onPick={vi.fn()} onClose={vi.fn()} />);
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No files"));
});

it("a query with no matches shows No matches", async () => {
  stubIndex();
  await open();
  type("zzzzqq");
  expect(screen.getByRole("status")).toHaveTextContent("No matches");
});

it("unmounting before the fetch settles sets no state", async () => {
  let resolve: (r: Response) => void = () => {};
  stub(() => new Promise<Response>((r) => { resolve = r; }));
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const view = render(<LocalFilePicker onPick={vi.fn()} onClose={vi.fn()} />);
  view.unmount();
  resolve(jsonResponse({ files: FILES }));
  await new Promise((r) => setTimeout(r, 0));
  expect(error).not.toHaveBeenCalled();
  error.mockRestore();
});
