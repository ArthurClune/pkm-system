import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InertMediaContext } from "../contexts";
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
  fireEvent.click(screen.getByRole("button", { name: "image from example.test: external" }));
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

it("traps the Escape that closes the overlay away from ancestor key handlers", () => {
  const onParentKeyDown = vi.fn();
  render(
    <div onKeyDown={onParentKeyDown}>
      <AssetImage src={ASSET} alt="photo" />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Expand image: photo" }));
  const close = screen.getByRole("button", { name: "Close" });

  fireEvent.keyDown(close, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(onParentKeyDown).not.toHaveBeenCalled();

  fireEvent.keyDown(
    screen.getByRole("button", { name: "Expand image: photo" }),
    { key: "Escape" },
  );
  expect(onParentKeyDown).toHaveBeenCalledTimes(1);
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

it("renders inert — no expand trigger — inside InertMediaContext", () => {
  render(
    <InertMediaContext.Provider value={true}>
      <AssetImage src="/assets/abc/pic.png" alt="pic" />
    </InertMediaContext.Provider>,
  );
  expect(screen.queryByRole("button", { name: /Expand image/ }))
    .not.toBeInTheDocument();
  expect(screen.getByRole("img", { name: "pic" })).toBeInTheDocument();
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

it("shows a loading placeholder until the image loads", () => {
  render(<AssetImage src={ASSET} alt="photo" />);
  expect(screen.getByText(/loading image/i)).toHaveTextContent("photo");
  fireEvent.load(screen.getByRole("img", { name: "photo" }));
  expect(screen.queryByText(/loading image/i)).toBeNull();
  expect(screen.getByRole("img", { name: "photo" })).toBeInTheDocument();
});

it("replaces the loading placeholder with the offline one when the image fails", () => {
  render(<AssetImage src="https://example.test/photo.png" alt="external" />);
  fireEvent.click(screen.getByRole("button", { name: "image from example.test: external" }));
  expect(screen.getByText(/loading image/i)).toBeInTheDocument();
  fireEvent.error(screen.getByRole("img", { name: "external" }));
  expect(screen.queryByText(/loading image/i)).toBeNull();
  expect(screen.getByText(/image unavailable offline/i)).toBeInTheDocument();
});

it("shows the loading placeholder again for a new source", () => {
  const { rerender } = render(<AssetImage src="/assets/a/x.png" alt="x" />);
  fireEvent.load(screen.getByRole("img", { name: "x" }));
  rerender(<AssetImage src="/assets/b/y.png" alt="y" />);
  expect(screen.getByText(/loading image/i)).toHaveTextContent("y");
});

it("skips the loading placeholder for an image the browser already holds", () => {
  const complete = vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
  const width = vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(10);
  try {
    const { rerender } = render(<AssetImage src="/assets/a/x.png" alt="x" />);
    expect(screen.queryByText(/loading image/i)).toBeNull();
    rerender(<AssetImage src="/assets/b/y.png" alt="y" />);
    expect(screen.queryByText(/loading image/i)).toBeNull();
  } finally {
    complete.mockRestore();
    width.mockRestore();
  }
});

it("renders an external image as a load button with no img until clicked", () => {
  render(<AssetImage src="https://example.test/photo.png" alt="external" />);
  expect(document.querySelector("img")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "image from example.test: external" }));
  expect(screen.getByRole("img", { name: "external" })).toHaveAttribute(
    "src", "https://example.test/photo.png");
});

// Every img src the DOM held at any point while `run` ran, including an img
// committed and removed again before `run` returned: the browser starts the
// fetch at commit, so one committed frame is already a request.
function imgSrcsCommittedDuring(run: () => void) {
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(document.body, {
    childList: true, subtree: true,
    attributes: true, attributeFilter: ["src"], attributeOldValue: true,
  });
  run();
  records.push(...observer.takeRecords());
  observer.disconnect();
  const srcs: string[] = [];
  const collect = (node: Node) => {
    if (!(node instanceof Element)) return;
    const imgs = node.matches("img") ? [node] : [...node.querySelectorAll("img")];
    for (const img of imgs) srcs.push(img.getAttribute("src") ?? "");
  };
  for (const record of records) {
    if (record.type === "attributes") {
      // oldValue keeps a src that a later change in the same batch replaced
      if (record.oldValue !== null) srcs.push(record.oldValue);
      collect(record.target);
    }
    record.addedNodes.forEach(collect);
    record.removedNodes.forEach(collect);
  }
  return { recordCount: records.length, srcs };
}

it("a new external src needs its own click", () => {
  const { rerender } = render(<AssetImage src="https://a.test/x.png" alt="x" />);
  fireEvent.click(screen.getByRole("button", { name: "image from a.test: x" }));
  expect(screen.getByRole("img", { name: "x" })).toBeInTheDocument();

  const committed = imgSrcsCommittedDuring(() =>
    rerender(<AssetImage src="https://b.test/y.png" alt="y" />));
  // the rerender swaps the img for the button, so an empty list means the
  // observer saw nothing, not that nothing leaked
  expect(committed.recordCount).toBeGreaterThan(0);
  expect(committed.srcs).not.toContain("https://b.test/y.png");
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("button", { name: "image from b.test: y" })).toBeInTheDocument();

  rerender(<AssetImage src="https://a.test/x.png" alt="x" />);
  expect(document.querySelector("img")).toBeNull();
  expect(screen.getByRole("button", { name: "image from a.test: x" })).toBeInTheDocument();
});

it("the load click does not reach ancestors", () => {
  const onParentClick = vi.fn();
  render(
    <div onClick={onParentClick}>
      <AssetImage src="https://example.test/photo.png" alt="external" />
    </div>,
  );
  fireEvent.click(screen.getByRole("button", { name: "image from example.test: external" }));
  expect(onParentClick).not.toHaveBeenCalled();
  expect(screen.getByRole("img", { name: "external" })).toBeInTheDocument();
});

it("an external image inside InertMediaContext is plain text", () => {
  render(
    <InertMediaContext.Provider value={true}>
      <AssetImage src="https://example.test/photo.png" alt="x" />
    </InertMediaContext.Provider>,
  );
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("image from example.test: x")).toBeInTheDocument();
  expect(document.querySelector("img")).toBeNull();
});
