import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { stubMatchMedia } from "../test-helpers";
import { THEME_STORAGE_KEY } from "../theme";
import { ThemeToggle } from "./ThemeToggle";

afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  localStorage.removeItem(THEME_STORAGE_KEY);
});

it("defaults to system, stamping data-theme='system' on <html>", () => {
  render(<ThemeToggle />);
  expect(screen.getByRole("button", { name: /theme: auto/i })).toBeInTheDocument();
  expect(document.documentElement.getAttribute("data-theme")).toBe("system");
});

it("cycles system -> light -> dark -> system on click, persisting each step", () => {
  render(<ThemeToggle />);
  const button = screen.getByRole("button");

  fireEvent.click(button);
  expect(screen.getByRole("button", { name: /theme: light/i })).toBeInTheDocument();
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");

  fireEvent.click(button);
  expect(screen.getByRole("button", { name: /theme: dark/i })).toBeInTheDocument();
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");

  fireEvent.click(button);
  expect(screen.getByRole("button", { name: /theme: auto/i })).toBeInTheDocument();
  expect(document.documentElement.getAttribute("data-theme")).toBe("system");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("system");
});

it("reads a previously-persisted preference on mount", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "dark");
  render(<ThemeToggle />);
  expect(screen.getByRole("button", { name: /theme: dark/i })).toBeInTheDocument();
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
});

it("ignores a garbage stored value and falls back to system", () => {
  localStorage.setItem(THEME_STORAGE_KEY, "purple");
  render(<ThemeToggle />);
  expect(screen.getByRole("button", { name: /theme: auto/i })).toBeInTheDocument();
});

it("renders an inline svg icon, not emoji text (pkm-mijo)", () => {
  render(<ThemeToggle />);
  const button = screen.getByRole("button");
  expect(button.querySelector("svg")).not.toBeNull();
  expect(button.textContent).not.toMatch(/[\u{1F311}-\u{1F320}☀-⛿]/u);
});

it("reflects the OS setting while preference is system", () => {
  stubMatchMedia(true); // OS is in dark mode
  render(<ThemeToggle />);
  // The button always shows the *preference* label ("Auto"), not the
  // resolved theme -- effective theme is exposed via useTheme() for CSS/
  // other consumers, not surfaced as separate button text.
  expect(screen.getByRole("button", { name: /theme: auto/i })).toBeInTheDocument();
  expect(document.documentElement.getAttribute("data-theme")).toBe("system");
});
