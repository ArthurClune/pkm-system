import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { AssetImage } from "./AssetImage";

it("renders the image with alt text", () => {
  render(<AssetImage src="/assets/abc/photo.png" alt="photo" />);
  const img = screen.getByRole("img", { name: "photo" });
  expect(img).toHaveAttribute("src", "/assets/abc/photo.png");
});

it("shows a placeholder when the image fails (uncached asset offline)", () => {
  render(<AssetImage src="/assets/abc/photo.png" alt="photo" />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.queryByRole("img")).toBeNull();
  const placeholder = screen.getByText(/image unavailable offline/i);
  expect(placeholder).toBeInTheDocument();
  expect(placeholder).toHaveTextContent("photo"); // keeps the alt for context
});

it("recovers when src changes after an error (reconnect re-render)", () => {
  const { rerender } = render(<AssetImage src="/assets/a/x.png" alt="x" />);
  fireEvent.error(screen.getByRole("img"));
  expect(screen.queryByRole("img")).toBeNull();
  rerender(<AssetImage src="/assets/b/y.png" alt="y" />);
  expect(screen.getByRole("img", { name: "y" })).toBeInTheDocument();
});
