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

function startEditing(title: string) {
  fireEvent.click(screen.getByRole("heading", { name: title }));
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
  const input = startEditing("My Page");
  expect(input.value).toBe("My Page");
});

it("Enter commits a rename and navigates to the new page", async () => {
  apiFetchMock.mockResolvedValue({ result: "renamed", title: "New Name" });
  mount("My Page");
  const input = startEditing("My Page");
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
  const input = startEditing("My Page");
  fireEvent.change(input, { target: { value: "Changed" } });
  fireEvent.keyDown(input, { key: "Escape" });
  fireEvent.blur(input);
  expect(apiFetchMock).not.toHaveBeenCalled();
  expect(screen.getByRole("heading", { name: "My Page" })).toBeInTheDocument();
});

it("unchanged or blank titles commit as a no-op", () => {
  mount("My Page");
  fireEvent.blur(startEditing("My Page"));
  const input = startEditing("My Page");
  fireEvent.change(input, { target: { value: "   " } });
  fireEvent.blur(input);
  expect(apiFetchMock).not.toHaveBeenCalled();
});

it("409 shows an in-app merge confirm dialog and retries with allow_merge", async () => {
  apiFetchMock
    .mockRejectedValueOnce(new ApiError(409, "/api/page/My%20Page/rename"))
    .mockResolvedValueOnce({ result: "merged", title: "Existing" });
  mount("My Page");
  const input = startEditing("My Page");
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
  const input = startEditing("My Page");
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
  const input = startEditing("My Page");
  fireEvent.change(input, { target: { value: "New Name" } });
  fireEvent.blur(input);
  await waitFor(() =>
    expect(screen.getByText(/request failed: 500/)).toBeInTheDocument());
  expect(screen.getByRole("heading", { name: "My Page" })).toBeInTheDocument();
});

it("daily-note titles are not editable", () => {
  mount("July 17th, 2026");
  fireEvent.click(screen.getByRole("heading", { name: "July 17th, 2026" }));
  expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
});
