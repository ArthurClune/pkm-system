import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AssetImage } from "./AssetImage";

const ASSET = "/assets/abc/photo.png";

afterEach(() => {
  document.body.style.overflow = "";
});

function openImage(alt = "photo") {
  render(<AssetImage src={ASSET} alt={alt} />);
  const trigger = screen.getByRole("button", { name: `Expand image: ${alt}` });
  fireEvent.click(trigger);
  return { trigger, dialog: screen.getByRole("dialog", { name: `Expanded image: ${alt}` }) };
}

it("renders an uploaded image as an accessible expansion trigger", () => {
  render(<AssetImage src={ASSET} alt="photo" />);
  const trigger = screen.getByRole("button", { name: "Expand image: photo" });
  const img = screen.getByRole("img", { name: "photo" });
  expect(trigger).toContainElement(img);
  expect(img).toHaveAttribute("src", ASSET);
  fireEvent.click(trigger);
  expect(screen.getByRole("dialog", { name: "Expanded image: photo" }))
    .toHaveAttribute("aria-modal", "true");
});

it("uses fallback accessible names when alt text is empty", () => {
  render(<AssetImage src={ASSET} alt="" />);
  fireEvent.click(screen.getByRole("button", { name: "Expand image" }));
  expect(screen.getByRole("dialog", { name: "Expanded image" })).toBeInTheDocument();
});

it("leaves external images non-expandable", () => {
  render(<AssetImage src="https://example.test/photo.png" alt="external" />);
  expect(screen.getByRole("img", { name: "external" })).toHaveAttribute(
    "src", "https://example.test/photo.png");
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("closes through Close, Escape, and an empty-stage click only", () => {
  const { trigger } = openImage();
  fireEvent.click(document.querySelector(".image-overlay-bar")!);
  fireEvent.click(screen.getAllByRole("img", { name: "photo" })[1]);
  expect(screen.getByRole("dialog")).toBeInTheDocument();

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(trigger);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();

  fireEvent.click(trigger);
  fireEvent.click(document.querySelector(".image-overlay-stage")!);
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("moves focus into the modal, traps Tab, restores focus, and restores body overflow", () => {
  document.body.style.overflow = "auto";
  render(<AssetImage src={ASSET} alt="photo" />);
  const trigger = screen.getByRole("button", { name: "Expand image: photo" });
  trigger.focus();
  fireEvent.click(trigger);
  const close = screen.getByRole("button", { name: "Close" });
  expect(close).toHaveFocus();
  expect(document.body.style.overflow).toBe("hidden");

  close.blur();
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(close).toHaveFocus();

  fireEvent.keyDown(window, { key: "Escape" });
  expect(trigger).toHaveFocus();
  expect(document.body.style.overflow).toBe("auto");
});

it("restores body overflow when unmounted while expanded", () => {
  document.body.style.overflow = "scroll";
  const { unmount } = render(<AssetImage src={ASSET} alt="photo" />);
  fireEvent.click(screen.getByRole("button", { name: "Expand image: photo" }));
  expect(document.body.style.overflow).toBe("hidden");
  unmount();
  expect(document.body.style.overflow).toBe("scroll");
});

it("contains trigger and portalled-overlay clicks inside the interactive island", () => {
  const onParentClick = vi.fn();
  render(
    <div onClick={onParentClick}>
      <AssetImage src={ASSET} alt="photo" />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand image: photo" }));
  expect(onParentClick).not.toHaveBeenCalled();

  fireEvent.click(screen.getAllByRole("img", { name: "photo" })[1]);
  expect(screen.getByRole("dialog")).toBeInTheDocument();
  expect(onParentClick).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onParentClick).not.toHaveBeenCalled();
});

it("shows the existing placeholder when either image fails", () => {
  const inline = render(<AssetImage src={ASSET} alt="photo" />);
  fireEvent.error(screen.getByRole("img", { name: "photo" }));
  expect(screen.getByText(/image unavailable offline/i)).toHaveTextContent("photo");
  inline.unmount();

  render(<AssetImage src={ASSET} alt="photo" />);
  fireEvent.click(screen.getByRole("button", { name: "Expand image: photo" }));
  fireEvent.error(screen.getAllByRole("img", { name: "photo" })[1]);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByText(/image unavailable offline/i)).toHaveTextContent("photo");
});

it("closes expansion on a source change and recovers from a prior failure", () => {
  const { rerender } = render(<AssetImage src="/assets/a/x.png" alt="x" />);
  fireEvent.click(screen.getByRole("button", { name: "Expand image: x" }));
  rerender(<AssetImage src="/assets/b/y.png" alt="y" />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("img", { name: "y" })).toHaveAttribute("src", "/assets/b/y.png");

  fireEvent.error(screen.getByRole("img", { name: "y" }));
  expect(screen.queryByRole("img")).toBeNull();
  rerender(<AssetImage src="/assets/c/z.png" alt="z" />);
  expect(screen.getByRole("img", { name: "z" })).toHaveAttribute("src", "/assets/c/z.png");
});
