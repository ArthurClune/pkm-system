import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { InertMediaContext, UntrustedContentContext } from "../contexts";
import { defer, jsonResponse, stubIosStandaloneNavigator } from "../test-helpers";
import { BlueskyEmbed } from "./BlueskyEmbed";
import { ExternalLinkInterceptor } from "./ExternalLinkInterceptor";

const DID = "did:plc:z72i7hdynmk6r22z27h6tvur";

function stubResolve(response: { ok: boolean; did?: string }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.ok ? 200 : 400,
    json: async () => ({ did: response.did }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function embedSrc(container: HTMLElement): URL | null {
  const iframe = container.querySelector("iframe.bluesky-embed");
  const src = iframe?.getAttribute("src");
  return src ? new URL(src) : null;
}

function embedBox(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>(".bluesky-embed-box");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("renders a DID-based post URL as an iframe immediately, with no fetch", () => {
  const fetchMock = stubResolve({ ok: true, did: DID });
  const href = `https://bsky.app/profile/${DID}/post/3k2abc123xy`;
  const { container } = render(<BlueskyEmbed href={href} />);
  const src = embedSrc(container);
  expect(src).not.toBeNull();
  expect(src!.origin).toBe("https://embed.bsky.app");
  expect(src!.pathname).toBe(`/embed/${DID}/app.bsky.feed.post/3k2abc123xy`);
  expect(src!.searchParams.get("ref_url")).toBe(href);
  expect(src!.searchParams.get("id")).toBeTruthy();
  expect(fetchMock).not.toHaveBeenCalled();
});

it("lazy-loads the embed iframe, like every other remote media in the app", () => {
  stubResolve({ ok: true, did: DID });
  const href = `https://bsky.app/profile/${DID}/post/3k2abc123xy`;
  const { container } = render(<BlueskyEmbed href={href} />);
  expect(container.querySelector("iframe.bluesky-embed")!.getAttribute("loading"))
    .toBe("lazy");
});

it("keeps allow-same-origin in the sandbox: an opaque origin blanks the embed", () => {
  stubResolve({ ok: true, did: DID });
  const href = `https://bsky.app/profile/${DID}/post/3k2abc123xy`;
  const { container } = render(<BlueskyEmbed href={href} />);
  const sandbox = container.querySelector("iframe.bluesky-embed")!.getAttribute("sandbox");
  expect(sandbox).toContain("allow-same-origin");
  expect(sandbox).toContain("allow-scripts");
});

it("resolves a handle to a DID and embeds using the DID", async () => {
  const fetchMock = stubResolve({ ok: true, did: DID });
  const href = "https://bsky.app/profile/resolve-me.bsky.social/post/3k2abc123xy";
  const { container } = render(<BlueskyEmbed href={href} />);
  await waitFor(() => {
    expect(container.querySelector("iframe.bluesky-embed")).not.toBeNull();
  });
  expect(embedSrc(container)!.pathname).toBe(`/embed/${DID}/app.bsky.feed.post/3k2abc123xy`);
  expect(fetchMock).toHaveBeenCalledWith(
    "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle" +
      "?handle=resolve-me.bsky.social",
  );
});

it("falls back to a plain link while resolving and when resolution fails", async () => {
  const fetchMock = stubResolve({ ok: false });
  const href = "https://bsky.app/profile/no-such.bsky.social/post/3k2abc123xy";
  const { container } = render(<BlueskyEmbed href={href} />);
  const link = container.querySelector("a");
  expect(link).not.toBeNull();
  expect(link).toHaveAttribute("href", href);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(container.querySelector("iframe.bluesky-embed")).toBeNull();
  expect(container.querySelector("a")).toHaveAttribute("href", href);
});

it("caches resolved handles across mounts", async () => {
  const fetchMock = stubResolve({ ok: true, did: DID });
  const href = "https://bsky.app/profile/cache-me.bsky.social/post/3k2abc123xy";
  const first = render(<BlueskyEmbed href={href} />);
  await waitFor(() => {
    expect(first.container.querySelector("iframe.bluesky-embed")).not.toBeNull();
  });
  const second = render(<BlueskyEmbed href={href} />);
  await waitFor(() => {
    expect(second.container.querySelector("iframe.bluesky-embed")).not.toBeNull();
  });
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("adopts the height the embed page reports for this embed's id", () => {
  stubResolve({ ok: true, did: DID });
  const href = `https://bsky.app/profile/${DID}/post/3k2abc123xy`;
  const { container } = render(<BlueskyEmbed href={href} />);
  const id = embedSrc(container)!.searchParams.get("id")!;
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://embed.bsky.app",
      data: { id: "someone-else", height: 111 },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://evil.example",
      data: { id, height: 222 },
    }));
    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://embed.bsky.app",
      data: { id, height: 543 },
    }));
  });
  const box = embedBox(container)!;
  expect(box.style.getPropertyValue("--bluesky-height")).toBe("543px");
});

it("wraps the iframe in a scaling box", () => {
  stubResolve({ ok: true, did: DID });
  const href = `https://bsky.app/profile/${DID}/post/3k2abc123xy`;
  const { container } = render(<BlueskyEmbed href={href} />);
  const box = embedBox(container);
  expect(box).not.toBeNull();
  expect(box!.querySelector("iframe.bluesky-embed")).not.toBeNull();
});

it("renders nothing for a non-post href", () => {
  stubResolve({ ok: true, did: DID });
  const { container } = render(<BlueskyEmbed href="https://bsky.app/profile/alice.bsky.social" />);
  expect(container).toBeEmptyDOMElement();
});

// --- actor/height identity reconciliation ---

it("ignores a resolved handle for an actor the href has since moved away from", async () => {
  const dids: Record<string, string> = {
    "alpha.bsky.social": "did:plc:alphaaaaaaaaaaaaaaaa",
    "beta.bsky.social": "did:plc:betaaaaaaaaaaaaaaaaaa",
  };
  const pending = new Map<string, ReturnType<typeof defer<Response>>>();
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const handle = new URL(String(input)).searchParams.get("handle")!;
    const d = defer<Response>();
    pending.set(handle, d);
    return d.promise;
  });
  vi.stubGlobal("fetch", fetchMock);

  const hrefA = "https://bsky.app/profile/alpha.bsky.social/post/aaa111";
  const hrefB = "https://bsky.app/profile/beta.bsky.social/post/bbb222";
  const { container, rerender } = render(<BlueskyEmbed href={hrefA} />);
  rerender(<BlueskyEmbed href={hrefB} />);

  // beta (the current actor) resolves first.
  pending.get("beta.bsky.social")!.resolve(jsonResponse({ did: dids["beta.bsky.social"] }));
  await waitFor(() => expect(embedSrc(container)?.pathname).toBe(
    `/embed/${dids["beta.bsky.social"]}/app.bsky.feed.post/bbb222`));

  // alpha's stale resolution arrives late; the href has moved on, so it must
  // not be adopted.
  await act(async () => {
    pending.get("alpha.bsky.social")!.resolve(jsonResponse({ did: dids["alpha.bsky.social"] }));
    await Promise.resolve();
  });
  expect(embedSrc(container)?.pathname).toBe(
    `/embed/${dids["beta.bsky.social"]}/app.bsky.feed.post/bbb222`);
});

it("replaces the embedded DID immediately when href moves to a different raw-DID actor", () => {
  const didX = "did:plc:xxxxxxxxxxxxxxxxxxxx";
  const didY = "did:plc:yyyyyyyyyyyyyyyyyyyy";
  const hrefX = `https://bsky.app/profile/${didX}/post/xxx111`;
  const hrefY = `https://bsky.app/profile/${didY}/post/yyy222`;
  const { container, rerender } = render(<BlueskyEmbed href={hrefX} />);
  expect(embedSrc(container)?.pathname).toBe(`/embed/${didX}/app.bsky.feed.post/xxx111`);

  rerender(<BlueskyEmbed href={hrefY} />);
  expect(embedSrc(container)?.pathname).toBe(`/embed/${didY}/app.bsky.feed.post/yyy222`);
});

it("resets the reported height when href changes to a different post", () => {
  stubResolve({ ok: true, did: DID });
  const hrefA = `https://bsky.app/profile/${DID}/post/postA111`;
  const hrefB = `https://bsky.app/profile/${DID}/post/postB222`;
  const { container, rerender } = render(<BlueskyEmbed href={hrefA} />);
  const idA = embedSrc(container)!.searchParams.get("id")!;
  act(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: "https://embed.bsky.app",
      data: { id: idA, height: 700 },
    }));
  });
  expect(embedBox(container)!.style.getPropertyValue("--bluesky-height")).toBe("700px");

  rerender(<BlueskyEmbed href={hrefB} />);
  expect(embedBox(container)!.style.getPropertyValue("--bluesky-height")).toBe("");
});

it("resolves the DID for a valid href after starting from an invalid href", () => {
  const validHref = `https://bsky.app/profile/${DID}/post/valid123`;
  const { container, rerender } = render(<BlueskyEmbed href="https://bsky.app/profile/alice.bsky.social" />);
  expect(container).toBeEmptyDOMElement();

  rerender(<BlueskyEmbed href={validHref} />);
  expect(container.querySelector("iframe.bluesky-embed")).not.toBeNull();
  expect(embedSrc(container)?.pathname).toBe(`/embed/${DID}/app.bsky.feed.post/valid123`);
});

it("in the iOS standalone app, a tap on the embed opens the post in Safari", () => {
  // the iframe is cross-origin, so a tap inside it never reaches the
  // interceptor and would open the in-app browser; an anchor over it does
  const restore = stubIosStandaloneNavigator();
  try {
    stubResolve({ ok: true, did: DID });
    const href = `https://bsky.app/profile/${DID}/post/3k2abc123xy`;
    const navigate = vi.fn();
    const { container } = render(
      <><ExternalLinkInterceptor navigate={navigate} /><BlueskyEmbed href={href} /></>,
    );
    const tap = embedBox(container)!.querySelector<HTMLAnchorElement>("a.bluesky-embed-tap");
    expect(tap).not.toBeNull();
    fireEvent.click(tap!);
    expect(navigate).toHaveBeenCalledWith(`x-safari-${href}`);
  } finally {
    restore();
  }
});

it("outside the iOS standalone app, the embed stays interactive", () => {
  const restore = stubIosStandaloneNavigator({ standalone: false });
  try {
    stubResolve({ ok: true, did: DID });
    const href = `https://bsky.app/profile/${DID}/post/3k2abc123xy`;
    const { container } = render(<BlueskyEmbed href={href} />);
    expect(embedBox(container)!.querySelector("a")).toBeNull();
  } finally {
    restore();
  }
});

function untrusted(ui: React.ReactElement, inert = false) {
  return (
    <UntrustedContentContext.Provider value={true}>
      <InertMediaContext.Provider value={inert}>{ui}</InertMediaContext.Provider>
    </UntrustedContentContext.Provider>
  );
}

const HANDLE_HREF = "https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy";

it("in untrusted content a handle post fetches nothing until clicked", async () => {
  const fetchMock = stubResolve({ ok: true, did: DID });
  const { container } = render(untrusted(<BlueskyEmbed href={HANDLE_HREF} />));
  expect(fetchMock).not.toHaveBeenCalled();
  expect(embedSrc(container)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Bluesky post from alice.bsky.social" }));
  await waitFor(() => expect(embedSrc(container)).not.toBeNull());
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

it("in untrusted content a DID post renders no iframe until clicked", () => {
  stubResolve({ ok: true, did: DID });
  const href = `https://bsky.app/profile/${DID}/post/3k2abc123xy`;
  const { container } = render(untrusted(<BlueskyEmbed href={href} />));
  expect(container.querySelector("iframe")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: `Bluesky post from ${DID}` }));
  expect(embedSrc(container)).not.toBeNull();
});

// Records every iframe src committed while `run` executes, even one removed
// again before it returns: the browser starts loading at commit.
function iframeSrcsCommittedDuring(run: () => void) {
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
    const frames = node.matches("iframe") ? [node] : [...node.querySelectorAll("iframe")];
    for (const frame of frames) srcs.push(frame.getAttribute("src") ?? "");
  };
  for (const record of records) {
    if (record.type === "attributes") {
      if (record.oldValue !== null) srcs.push(record.oldValue);
      collect(record.target);
    }
    record.addedNodes.forEach(collect);
    record.removedNodes.forEach(collect);
  }
  return { recordCount: records.length, srcs };
}

it("a new href needs its own click", async () => {
  const fetchMock = stubResolve({ ok: true, did: DID });
  // handles are cached app-wide, so this test uses its own
  const first = "https://bsky.app/profile/carol.bsky.social/post/3k2abc123xy";
  // a DID post, so a one-frame commit would put an iframe in the record
  const other = `https://bsky.app/profile/${DID}/post/3k2abc123xy`;
  const { container, rerender } = render(untrusted(<BlueskyEmbed href={first} />));
  fireEvent.click(screen.getByRole("button", { name: "Bluesky post from carol.bsky.social" }));
  await waitFor(() => expect(embedSrc(container)).not.toBeNull());
  expect(fetchMock).toHaveBeenCalledTimes(1);

  const committed = iframeSrcsCommittedDuring(() =>
    rerender(untrusted(<BlueskyEmbed href={other} />)));
  expect(committed.recordCount).toBeGreaterThan(0);
  expect(committed.srcs.some((src) => src.includes(encodeURIComponent(other)))).toBe(false);
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.getByRole("button", { name: `Bluesky post from ${DID}` }))
    .toBeInTheDocument();
  expect(fetchMock).toHaveBeenCalledTimes(1);

  rerender(untrusted(<BlueskyEmbed href={first} />));
  expect(container.querySelector("iframe")).toBeNull();
  expect(screen.getByRole("button", { name: "Bluesky post from carol.bsky.social" }))
    .toBeInTheDocument();
});

it("the load click does not reach ancestors", () => {
  stubResolve({ ok: true, did: DID });
  const onParentClick = vi.fn();
  render(untrusted(
    <div onClick={onParentClick}><BlueskyEmbed href={HANDLE_HREF} /></div>,
  ));
  fireEvent.click(screen.getByRole("button", { name: "Bluesky post from alice.bsky.social" }));
  expect(onParentClick).not.toHaveBeenCalled();
});

it("in untrusted, inert content the placeholder is plain text", () => {
  const fetchMock = stubResolve({ ok: true, did: DID });
  const { container } = render(untrusted(<BlueskyEmbed href={HANDLE_HREF} />, true));
  expect(screen.queryByRole("button")).toBeNull();
  expect(screen.getByText("Bluesky post from alice.bsky.social")).toBeInTheDocument();
  expect(container.querySelector("iframe")).toBeNull();
  expect(fetchMock).not.toHaveBeenCalled();
});
