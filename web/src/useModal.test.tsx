import { fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useRef, type RefObject } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { useModal } from "./useModal";

const outside: HTMLElement[] = [];

afterEach(() => {
  document.body.style.overflow = "";
  for (const element of outside.splice(0)) element.remove();
});

/** A surface of buttons named `${id}-${label}`; the one at `initial` takes
 * focus on mount. */
function Modal({
  id, labels = ["a", "b", "c"], initial = 0, onClose = () => {}, onKey,
  trap, triggerRef,
}: {
  id: string;
  labels?: string[];
  initial?: number;
  onClose?: () => void;
  onKey?: (event: KeyboardEvent) => void;
  trap?: "cycle" | "pin";
  triggerRef?: RefObject<HTMLElement | null>;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const initialRef = useRef<HTMLButtonElement>(null);
  useModal({
    surfaceRef, initialFocusRef: initialRef, onClose, onKey, trap, triggerRef,
  });
  return (
    <div ref={surfaceRef}>
      {labels.map((label, i) => (
        <button key={label} type="button"
                ref={i === initial ? initialRef : undefined}>
          {`${id}-${label}`}
        </button>
      ))}
    </div>
  );
}

/** A button outside every modal, attached to the document by hand so a
 * test can focus it before anything renders and remove it later. */
function outsideButton(): HTMLButtonElement {
  const button = document.createElement("button");
  button.textContent = "outside";
  document.body.appendChild(button);
  outside.push(button);
  return button;
}

const button = (name: string) => screen.getByRole("button", { name });

it("focuses the initial target on mount and the trigger on unmount", () => {
  const trigger = outsideButton();
  const triggerRef = { current: trigger };
  const view = render(<Modal id="m" initial={1} triggerRef={triggerRef} />);
  expect(button("m-b")).toHaveFocus();
  view.unmount();
  expect(trigger).toHaveFocus();
});

it("restores focus to the element focused before mount when no trigger is given", () => {
  const before = outsideButton();
  before.focus();
  const view = render(<Modal id="m" />);
  expect(button("m-a")).toHaveFocus();
  view.unmount();
  expect(before).toHaveFocus();
});

it("skips the restore when its target has left the document", () => {
  const before = outsideButton();
  before.focus();
  const view = render(<Modal id="m" />);
  before.remove();
  view.unmount();
  expect(document.activeElement).toBe(document.body);

  const trigger = outsideButton();
  const second = render(<Modal id="n" triggerRef={{ current: trigger }} />);
  trigger.remove();
  second.unmount();
  expect(document.activeElement).toBe(document.body);
});

it("Tab from the last focusable wraps to the first, and Shift+Tab from the first to the last", () => {
  render(<Modal id="m" initial={2} />);
  expect(fireEvent.keyDown(window, { key: "Tab" })).toBe(false);
  expect(button("m-a")).toHaveFocus();
  expect(fireEvent.keyDown(window, { key: "Tab", shiftKey: true }))
    .toBe(false);
  expect(button("m-c")).toHaveFocus();

  // Mid-list the browser's own order already stays inside.
  button("m-b").focus();
  expect(fireEvent.keyDown(window, { key: "Tab" })).toBe(true);
  expect(fireEvent.keyDown(window, { key: "Tab", shiftKey: true }))
    .toBe(true);
  expect(button("m-b")).toHaveFocus();
});

it("Tab from outside the surface pulls focus to the first focusable", () => {
  const outside = outsideButton();
  render(<Modal id="m" initial={2} />);
  outside.focus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(button("m-a")).toHaveFocus();
});

it("pin mode keeps Tab on the initial target", () => {
  render(<Modal id="m" initial={1} trap="pin" />);
  button("m-c").focus();
  expect(fireEvent.keyDown(window, { key: "Tab" })).toBe(false);
  expect(button("m-b")).toHaveFocus();
  expect(fireEvent.keyDown(window, { key: "Tab", shiftKey: true }))
    .toBe(false);
  expect(button("m-b")).toHaveFocus();
});

it("Escape calls onClose once and reaches neither a bubbling window listener nor a React ancestor's onKeyDown", () => {
  const onClose = vi.fn();
  const onAncestorKeyDown = vi.fn();
  const onWindowKeyDown = vi.fn();
  window.addEventListener("keydown", onWindowKeyDown);
  try {
    render(
      <div onKeyDown={onAncestorKeyDown}>
        <Modal id="m" onClose={onClose} />
      </div>,
    );
    const notPrevented = fireEvent.keyDown(button("m-a"), { key: "Escape" });
    expect(notPrevented).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onAncestorKeyDown).not.toHaveBeenCalled();
    expect(onWindowKeyDown).not.toHaveBeenCalled();

    // Any other key still reaches both.
    fireEvent.keyDown(button("m-a"), { key: "x" });
    expect(onAncestorKeyDown).toHaveBeenCalledTimes(1);
    expect(onWindowKeyDown).toHaveBeenCalledTimes(1);
  } finally {
    window.removeEventListener("keydown", onWindowKeyDown);
  }
});

it("with two modals open only the later one answers Escape, Tab and onKey", () => {
  const outer = { onClose: vi.fn(), onKey: vi.fn() };
  const inner = { onClose: vi.fn(), onKey: vi.fn() };
  render(
    <>
      <Modal id="outer" {...outer} />
      <Modal id="inner" labels={["a", "b"]} initial={1} {...inner} />
    </>,
  );
  expect(button("inner-b")).toHaveFocus();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(inner.onClose).toHaveBeenCalledTimes(1);
  expect(outer.onClose).not.toHaveBeenCalled();

  fireEvent.keyDown(window, { key: "Tab" });
  expect(button("inner-a")).toHaveFocus();
  button("outer-c").focus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(button("inner-a")).toHaveFocus();

  fireEvent.keyDown(window, { key: "Enter" });
  expect(inner.onKey).toHaveBeenCalledTimes(1);
  expect(outer.onKey).not.toHaveBeenCalled();
});

function Stack({ outer, inner }: { outer: boolean; inner: boolean }) {
  return (
    <>
      {outer && <Modal key="outer" id="outer" />}
      {inner && <Modal key="inner" id="inner" initial={1} />}
    </>
  );
}

it("closing the outer modal first neither unlocks scrolling nor moves focus", () => {
  const before = outsideButton();
  before.focus();
  const view = render(<Stack outer inner={false} />);
  view.rerender(<Stack outer inner />);
  expect(button("inner-b")).toHaveFocus();

  view.rerender(<Stack outer={false} inner />);
  expect(document.body.style.overflow).toBe("hidden");
  expect(button("inner-b")).toHaveFocus();
});

it("the body stays locked until the last modal closes, then gets its prior overflow back", () => {
  document.body.style.overflow = "auto";
  const view = render(<Stack outer inner={false} />);
  expect(document.body.style.overflow).toBe("hidden");
  view.rerender(<Stack outer inner />);
  expect(document.body.style.overflow).toBe("hidden");

  view.rerender(<Stack outer inner={false} />);
  expect(document.body.style.overflow).toBe("hidden");
  // The inner one restores to what was focused when it opened.
  expect(button("outer-a")).toHaveFocus();

  view.rerender(<Stack outer={false} inner={false} />);
  expect(document.body.style.overflow).toBe("auto");
});

it("a new onClose identity on re-render neither re-runs the effect nor moves focus", () => {
  const first = vi.fn();
  const second = vi.fn();
  const view = render(<Modal id="m" onClose={first} />);
  button("m-c").focus();
  view.rerender(<Modal id="m" onClose={second} />);
  expect(button("m-c")).toHaveFocus();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(second).toHaveBeenCalledTimes(1);
  expect(first).not.toHaveBeenCalled();
});

it("onKey hears Enter while topmost, and not while another modal is above", () => {
  const onKey = vi.fn();
  const view = render(<Modal key="outer" id="outer" onKey={onKey} />);
  fireEvent.keyDown(window, { key: "Enter" });
  expect(onKey).toHaveBeenCalledTimes(1);
  expect(onKey.mock.calls[0][0]).toMatchObject({ key: "Enter" });

  view.rerender(
    <>
      <Modal key="outer" id="outer" onKey={onKey} />
      <Modal key="inner" id="inner" />
    </>,
  );
  fireEvent.keyDown(window, { key: "Enter" });
  expect(onKey).toHaveBeenCalledTimes(1);

  view.rerender(<Modal key="outer" id="outer" onKey={onKey} />);
  fireEvent.keyDown(window, { key: "Enter" });
  expect(onKey).toHaveBeenCalledTimes(2);
});

it("under StrictMode the stack, the overflow and the focus balance after mount and unmount", () => {
  document.body.style.overflow = "auto";
  const before = outsideButton();
  before.focus();
  const onClose = vi.fn();
  const view = render(
    <StrictMode><Modal id="m" initial={1} onClose={onClose} /></StrictMode>,
  );
  expect(button("m-b")).toHaveFocus();
  expect(document.body.style.overflow).toBe("hidden");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);

  view.unmount();
  expect(document.body.style.overflow).toBe("auto");
  expect(before).toHaveFocus();

  // A leaked stack entry would keep the next modal's close from unlocking.
  const next = render(<Modal id="n" />);
  expect(document.body.style.overflow).toBe("hidden");
  next.unmount();
  expect(document.body.style.overflow).toBe("auto");
});
