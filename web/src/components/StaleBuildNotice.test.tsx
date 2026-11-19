import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanReload } from "../cleanReload";
import { noteServedBuild, resetStaleBuild } from "../staleBuild";
import { StaleBuildNotice } from "./StaleBuildNotice";

vi.mock("../cleanReload", () => ({ cleanReload: vi.fn(async () => undefined) }));

afterEach(() => resetStaleBuild());

test("shows nothing while the build is current", () => {
  const { container } = render(<StaleBuildNotice />);
  expect(container).toBeEmptyDOMElement();
});

test("offers a clean reload once the server serves another build", () => {
  render(<StaleBuildNotice />);
  act(() => noteServedBuild("b", "a"));
  const banner = screen.getByRole("status");
  expect(banner).toHaveClass("ws-banner", "stale-build");
  expect(banner).toHaveTextContent("A newer version of pkm is available.");
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  expect(cleanReload).toHaveBeenCalledOnce();
});
