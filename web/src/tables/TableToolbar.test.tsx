import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TableToolbar } from "./TableToolbar";

type Props = Parameters<typeof TableToolbar>[0];

function mount(over: Partial<Props> = {}) {
  const props: Props = {
    filter: "", onFilter: vi.fn(), count: "2 of 2 results",
    dirty: false, saved: false, canSave: true, refusal: null,
    onReset: vi.fn(), onSave: vi.fn(), ...over,
  };
  render(<TableToolbar {...props} />);
  return props;
}

describe("TableToolbar", () => {
  it("shows the filter and the count, and typing reports the filter", () => {
    const p = mount({ filter: "kind" });
    const box = screen.getByRole("searchbox", { name: "Filter" });
    expect(box).toHaveValue("kind");
    expect(box).toHaveClass("input-control");
    expect(screen.getByText("2 of 2 results")).toBeInTheDocument();
    fireEvent.change(box, { target: { value: "kindle" } });
    expect(p.onFilter).toHaveBeenCalledWith("kindle");
  });

  it("a clean saved view says so and offers no Reset or Save", () => {
    mount({ saved: true });
    expect(screen.getByText("✓ saved view")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reset" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Save this view" })).toBeNull();
  });

  it("a dirty view offers Reset and Save, and drops the saved label", () => {
    const p = mount({ saved: true, dirty: true });
    expect(screen.queryByText("✓ saved view")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    fireEvent.click(screen.getByRole("button", { name: "Save this view" }));
    expect(p.onReset).toHaveBeenCalledTimes(1);
    expect(p.onSave).toHaveBeenCalledTimes(1);
  });

  it("Save is disabled without canSave", () => {
    mount({ dirty: true, canSave: false });
    expect(screen.getByRole("button", { name: "Save this view" })).toBeDisabled();
  });

  it("a refusal replaces Save with its message", () => {
    mount({ dirty: true, refusal: "A filter with [[ cannot be saved" });
    expect(screen.queryByRole("button", { name: "Save this view" })).toBeNull();
    expect(screen.getByText("A filter with [[ cannot be saved"))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("Edit as text appears only with its handler", () => {
    mount();
    expect(screen.queryByRole("button", { name: "Edit as text" })).toBeNull();
  });

  it("Edit as text calls its handler", () => {
    const onEditAsText = vi.fn();
    mount({ onEditAsText });
    fireEvent.click(screen.getByRole("button", { name: "Edit as text" }));
    expect(onEditAsText).toHaveBeenCalledTimes(1);
  });

  it("clicks and keys in the toolbar do not reach the host block", () => {
    const hostClick = vi.fn();
    const hostKey = vi.fn();
    render(
      <div onClick={hostClick} onKeyDown={hostKey}>
        <TableToolbar filter="" onFilter={vi.fn()} count="0 of 0 rows"
                      dirty saved={false} canSave refusal={null}
                      onReset={vi.fn()} onSave={vi.fn()} />
      </div>);
    const box = screen.getByRole("searchbox", { name: "Filter" });
    fireEvent.click(box);
    fireEvent.keyDown(box, { key: "a" });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    expect(hostClick).not.toHaveBeenCalled();
    expect(hostKey).not.toHaveBeenCalled();
  });
});
