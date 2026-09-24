import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { jsonResponse } from "../test-helpers";
import { GoodlinksLink } from "./GoodlinksLink";

const ID = "e4966bb2483b5c78f658398c0ae7b03f";
const ARTICLE = { id: ID, title: "UML My Part", url: "https://tratt.net/uml.html",
                  added_at: "2022-10-06T15:07:12Z", html: "<p>Archived</p>" };

afterEach(() => vi.unstubAllGlobals());

it("a parent re-render while the reader is open leaves the dismiss effect alone", async () => {
  vi.stubGlobal("fetch", vi.fn<typeof fetch>(async () => jsonResponse(ARTICLE)));
  const view = render(<GoodlinksLink linkId={ID} label="Goodlinks" />);
  fireEvent.click(screen.getByRole("button", { name: "Goodlinks" }));
  await waitFor(() => expect(screen.getByTitle("UML My Part")).toBeInTheDocument());
  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toHaveFocus();

  // A re-run of the effect would restore focus to the trigger in cleanup and
  // then move it back to Close, so the end state alone cannot show it; count
  // the focus moves instead.
  const focusMoves = vi.fn();
  document.addEventListener("focusin", focusMoves);
  view.rerender(<GoodlinksLink linkId={ID} label="Goodlinks" />);
  document.removeEventListener("focusin", focusMoves);

  expect(focusMoves).not.toHaveBeenCalled();
  expect(close).toHaveFocus();
  expect(document.body.style.overflow).toBe("hidden");
});
