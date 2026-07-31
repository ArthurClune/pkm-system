import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { beforeEach, expect, it, vi } from "vitest";
import { ApiError, apiFetch } from "../api/client";
import { ROUTER_FUTURE_FLAGS } from "../router";
import { PageTitle } from "./PageTitle";

vi.mock("../api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/client")>();
  return { ...actual, apiFetch: vi.fn() };
});
const apiFetchMock = vi.mocked(apiFetch);

function Probe() {
  const loc = useLocation();
  return <p data-testid="loc">{loc.pathname}</p>;
}

function mount(title: string) {
  render(
    <MemoryRouter future={ROUTER_FUTURE_FLAGS} initialEntries={["/page/x"]}>
      <PageTitle title={title} />
      <Probe />
    </MemoryRouter>);
}

function startEditing() {
  fireEvent.click(screen.getByRole("button", { name: "Edit title" }));
  return screen.getByRole("textbox") as HTMLInputElement;
}

beforeEach(() => {
  apiFetchMock.mockReset();
});

it("renders the title as a heading", () => {
  mount("My Page");
  expect(screen.getByRole("heading", { name: "My Page" })).toBeInTheDocument();
});

it("click swaps to an input holding the current title", () => {
  mount("My Page");
  const input = startEditing();
  expect(input.value).toBe("My Page");
});

it("Enter commits a rename and navigates to the new page", async () => {
  apiFetchMock.mockResolvedValue({ result: "renamed", title: "New Name" });
  mount("My Page");
  const input = startEditing();
  fireEvent.change(input, { target: { value: "New Name" } });
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(screen.getByTestId("loc")).toHaveTextContent("/page/New%20Name"));
  expect(apiFetchMock).toHaveBeenCalledWith("/api/page/My%20Page/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ new_title: "New Name", allow_merge: false }),
  });
});

it("Escape reverts without calling the API", () => {
  mount("My Page");
  const input = startEditing();
  fireEvent.change(input, { target: { value: "Changed" } });
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.blur(input);
  expect(apiFetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "My Page" })).toBeInTheDocument();
});

it("unchanged or blank titles commit as a no-op", () => {
  mount("My Page");
  fireEvent.blur(startEditing());
  const input = startEditing();
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.blur(input);
  expect(apiFetchMock).not.toHaveBeenCalled();
});

it("409 shows an in-app merge confirm dialog and retries with allow_merge", async () => {
  apiFetchMock
    .mockRejectedValueOnce(new ApiError(409, "/api/page/My%20Page/rename"))
    .mockResolvedValueOnce({ result: "merged", title: "Existing" });
  mount("My Page");
  const input = startEditing();
  fireEvent.change(input, { target: { value: "Existing" } });
  fireEvent.blur(input);
  await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
  expect(screen.getByRole("alertdialog")).toHaveTextContent(
    'Page "Existing" already exists — merge this page into it?');
  fireEvent.click(screen.getByRole("button", { name: "Merge" }));

  await waitFor(() =>
    expect(screen.getByTestId("loc")).toHaveTextContent("/page/Existing"));
  expect(apiFetchMock).toHaveBeenLastCalledWith(
    "/api/page/My%20Page/rename", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ new_title: "Existing", allow_merge: true }),
    });
  expect(screen.queryByRole("alertdialog")).toBeNull();
});

it("declining the merge confirm leaves everything alone", async () => {
  apiFetchMock.mockRejectedValue(new ApiError(409, "x"));
  mount("My Page");
  const input = startEditing();
  fireEvent.change(input, { target: { value: "Existing" } });
  fireEvent.blur(input);
  await waitFor(() => expect(screen.getByRole("alertdialog")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  await waitFor(() => expect(apiFetchMock).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.getByTestId("loc")).toHaveTextContent("/page/x");
  expect(screen.getByRole("heading", { name: "My Page" })).toBeInTheDocument();
});

it("other errors revert and surface a message", async () => {
  apiFetchMock.mockRejectedValue(new ApiError(500, "x"));
  mount("My Page");
  const input = startEditing();
  fireEvent.change(input, { target: { value: "New Name" } });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(screen.getByText(/request failed: 500/)).toBeInTheDocument());
  expect(screen.getByRole("heading", { name: "My Page" })).toBeInTheDocument();
});

it("the editable title is a focusable button inside the heading (pkm-l4z8)", () => {
  mount("My Page");
  const heading = screen.getByRole("heading", { name: "My Page" });
  const trigger = screen.getByRole("button", { name: "Edit title" });
  // the heading keeps its place in the document outline; the control inside it
  // is a native <button>, so Enter/Space activate it (jsdom does not
  // synthesise that activation click, which is why this asserts the element
  // type and focusability rather than firing a keydown)
  expect(heading).toContainElement(trigger);
  expect(trigger.tagName).toBe("BUTTON");
  trigger.focus();
  expect(trigger).toHaveFocus();
  fireEvent.click(trigger);
  expect(screen.getByRole("textbox")).toHaveValue("My Page");
});

it("daily-note titles are not editable", () => {
  mount("July 17th, 2026");
  expect(screen.queryByRole("button", { name: "Edit title" })).toBeNull();
  fireEvent.click(screen.getByRole("heading", { name: "July 17th, 2026" }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});

// A title containing a word like "Cancel" or "Merge" must not create a
// second match for a getByRole("button", { name }) query aimed at an
// unrelated dialog button elsewhere on the page -- exactly the strict-mode
// violation / wrong-element click an e2e page titled "...Cancel..." or
// "Merge A g0t5" hit before the button's name was fixed text (pkm-l4z8).
it("the edit button's name does not change with title content", () => {
  mount("Merge A g0t5, please Cancel this");
  expect(screen.getByRole("button", { name: "Edit title" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Merge" })).toBeNull();
});
