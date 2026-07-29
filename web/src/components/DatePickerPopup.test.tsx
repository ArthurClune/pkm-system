import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { DatePickerPopup } from "./DatePickerPopup";

describe("DatePickerPopup (pkm-rw6w)", () => {
  test("shows the initial month and reports a clicked day", () => {
    const onPick = vi.fn();
    render(<DatePickerPopup initial={new Date(2026, 6, 29)} onPick={onPick} />);
    expect(screen.getByText("July 2026")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "15" }));
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 6, 15));
  });

  test("month navigation moves the view without firing onPick", () => {
    const onPick = vi.fn();
    render(<DatePickerPopup initial={new Date(2026, 6, 29)} onPick={onPick} />);
    fireEvent.mouseDown(screen.getByRole("button", { name: "previous month" }));
    expect(screen.getByText("June 2026")).toBeTruthy();
    fireEvent.mouseDown(screen.getByRole("button", { name: "next month" }));
    fireEvent.mouseDown(screen.getByRole("button", { name: "next month" }));
    expect(screen.getByText("August 2026")).toBeTruthy();
    expect(onPick).not.toHaveBeenCalled();
    // mid-month day: edge numbers (29-31, 1-2) can appear twice in a grid
    // (outside cells), so only days 3-28 are safe for name-based queries
    fireEvent.mouseDown(screen.getByRole("button", { name: "20" }));
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 7, 20));
  });

  test("days outside the month are marked and still pickable", () => {
    const onPick = vi.fn();
    const { container } = render(
      <DatePickerPopup initial={new Date(2026, 6, 29)} onPick={onPick} />);
    const outside = container.querySelectorAll(".date-picker-day.outside");
    expect(outside.length).toBe(4); // Jun 29, 30 + Aug 1, 2
    fireEvent.mouseDown(outside[0]);
    expect(onPick).toHaveBeenCalledWith(new Date(2026, 5, 29));
  });
});
