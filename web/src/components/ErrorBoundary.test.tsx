import { render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Bomb(): never {
  throw new Error("kaboom");
}

test("catches render errors and shows a fallback with a reload link", () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  render(<ErrorBoundary><Bomb /></ErrorBoundary>);
  expect(screen.getByText("Something went wrong")).toBeInTheDocument();
  expect(screen.getByText(/kaboom/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Reload" })).toHaveAttribute("href", "/");
});

test("renders children when nothing throws", () => {
  render(<ErrorBoundary><p>fine</p></ErrorBoundary>);
  expect(screen.getByText("fine")).toBeInTheDocument();
});
