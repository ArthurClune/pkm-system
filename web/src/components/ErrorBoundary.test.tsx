import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { cleanReload } from "../cleanReload";
import { ErrorBoundary } from "./ErrorBoundary";

vi.mock("../cleanReload", () => ({ cleanReload: vi.fn(async () => undefined) }));

function Bomb(): never {
  throw new Error("kaboom");
}

test("catches render errors and shows a fallback whose Reload is clean", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(<ErrorBoundary><Bomb /></ErrorBoundary>);
  expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  expect(screen.getByText(/kaboom/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(cleanReload).toHaveBeenCalledOnce();
});

test("renders children when nothing throws", () => {
  render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
  expect(screen.getByText("fine")).toBeInTheDocument();
});
