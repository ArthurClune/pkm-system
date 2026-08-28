import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ExternalLinkInterceptor } from "./ExternalLinkInterceptor";

/** Stub the bits of `navigator` the predicate reads, for the duration of one
 * test. jsdom's own `navigator` properties are configurable, so
 * `Object.defineProperty` can override them cleanly and this restores the
 * originals afterwards. */
function stubIosStandaloneNavigator(over: {
  platform?: string;
  maxTouchPoints?: number;
  standalone?: boolean;
} = {}) {
  const props: Record<string, PropertyDescriptor> = {};
  const values: Record<string, unknown> = {
    platform: over.platform ?? "iPhone",
    maxTouchPoints: over.maxTouchPoints ?? 5,
    standalone: over.standalone ?? true,
  };
  for (const [key, value] of Object.entries(values)) {
    props[key] = Object.getOwnPropertyDescriptor(window.navigator, key) ?? {
      configurable: true, enumerable: true, writable: true, value: undefined,
    };
    Object.defineProperty(window.navigator, key, {
      configurable: true, enumerable: true, value,
    });
  }
  return () => {
    for (const [key, descriptor] of Object.entries(props)) {
      Object.defineProperty(window.navigator, key, descriptor);
    }
  };
}

/** Anchor clicks that the interceptor is expected to leave alone still hit a
 * real `<a>`; jsdom logs "Not implemented: navigation" for any such click
 * that reaches it un-prevented (see test-setup.ts), so negative-case tests
 * add their own bubble-phase listener to preventDefault after assertions. */
function preventNativeNavigation() {
  const handler = (e: Event) => e.preventDefault();
  document.addEventListener("click", handler);
  return () => document.removeEventListener("click", handler);
}

describe("ExternalLinkInterceptor", () => {
  it("does nothing when not iOS standalone", () => {
    const restore = stubIosStandaloneNavigator({ standalone: false });
    const navigate = vi.fn();
    const stopNativeNav = preventNativeNavigation();
    render(<ExternalLinkInterceptor navigate={navigate} />);
    document.body.innerHTML += '<a href="https://other.example.com/">ext</a>';
    fireEvent.click(document.querySelector("a")!);
    expect(navigate).not.toHaveBeenCalled();
    stopNativeNav();
    restore();
  });

  it("rewrites a plain click on an external link to x-safari-https", () => {
    const restore = stubIosStandaloneNavigator();
    const navigate = vi.fn();
    render(<ExternalLinkInterceptor navigate={navigate} />);
    const a = document.createElement("a");
    a.href = "https://other.example.com/page";
    a.textContent = "ext";
    document.body.appendChild(a);

    fireEvent.click(a);

    expect(navigate).toHaveBeenCalledWith("x-safari-https://other.example.com/page");
    a.remove();
    restore();
  });

  it("leaves a same-origin link alone", () => {
    const restore = stubIosStandaloneNavigator();
    const navigate = vi.fn();
    const stopNativeNav = preventNativeNavigation();
    render(<ExternalLinkInterceptor navigate={navigate} />);
    const a = document.createElement("a");
    a.href = "/some/page";
    document.body.appendChild(a);

    fireEvent.click(a);

    expect(navigate).not.toHaveBeenCalled();
    a.remove();
    stopNativeNav();
    restore();
  });

  it("leaves a click with a modifier key alone", () => {
    const restore = stubIosStandaloneNavigator();
    const navigate = vi.fn();
    const stopNativeNav = preventNativeNavigation();
    render(<ExternalLinkInterceptor navigate={navigate} />);
    const a = document.createElement("a");
    a.href = "https://other.example.com/";
    document.body.appendChild(a);

    fireEvent.click(a, { metaKey: true });

    expect(navigate).not.toHaveBeenCalled();
    a.remove();
    stopNativeNav();
    restore();
  });

  it("ignores clicks that don't land on an anchor", () => {
    const restore = stubIosStandaloneNavigator();
    const navigate = vi.fn();
    render(<ExternalLinkInterceptor navigate={navigate} />);
    const div = document.createElement("div");
    div.textContent = "not a link";
    document.body.appendChild(div);

    fireEvent.click(div);

    expect(navigate).not.toHaveBeenCalled();
    div.remove();
    restore();
  });

  it("respects a click whose default was already prevented by an earlier capture-phase listener", () => {
    const restore = stubIosStandaloneNavigator();
    const navigate = vi.fn();
    // Capture-phase listeners on the same node (document) run in
    // registration order, so registering this before the interceptor mounts
    // means it runs first -- unlike a bubble-phase listener on the anchor
    // itself, which would run *after* the interceptor's capture-phase one.
    const preventEarly = (e: Event) => e.preventDefault();
    document.addEventListener("click", preventEarly, { capture: true });
    render(<ExternalLinkInterceptor navigate={navigate} />);
    const a = document.createElement("a");
    a.href = "https://other.example.com/";
    document.body.appendChild(a);

    fireEvent.click(a);

    expect(navigate).not.toHaveBeenCalled();
    a.remove();
    document.removeEventListener("click", preventEarly, { capture: true });
    restore();
  });

  it("finds the anchor when the click target is a descendant element", () => {
    const restore = stubIosStandaloneNavigator();
    const navigate = vi.fn();
    render(<ExternalLinkInterceptor navigate={navigate} />);
    const a = document.createElement("a");
    a.href = "https://other.example.com/deep";
    const span = document.createElement("span");
    span.textContent = "ext";
    a.appendChild(span);
    document.body.appendChild(a);

    fireEvent.click(span);

    expect(navigate).toHaveBeenCalledWith("x-safari-https://other.example.com/deep");
    a.remove();
    restore();
  });

  it("removes its document listener on unmount", () => {
    const restore = stubIosStandaloneNavigator();
    const navigate = vi.fn();
    const view = render(<ExternalLinkInterceptor navigate={navigate} />);
    const a = document.createElement("a");
    a.href = "https://other.example.com/";
    document.body.appendChild(a);
    const stopNativeNav = preventNativeNavigation();

    view.unmount();
    fireEvent.click(a);

    expect(navigate).not.toHaveBeenCalled();
    a.remove();
    stopNativeNav();
    restore();
  });

  it("renders nothing", () => {
    const restore = stubIosStandaloneNavigator();
    const { container } = render(<ExternalLinkInterceptor navigate={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
    restore();
  });
});
