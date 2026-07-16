import { act, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { defer, jsonResponse } from "../test-helpers";
import { BlueskyEmbed } from "./BlueskyEmbed";

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
  const iframe = container.querySelector<HTMLIFrameElement>("iframe.bluesky-embed")!;
  expect(iframe.style.height).toBe("543px");
});

it("renders nothing for a non-post href", () => {
  stubResolve({ ok: true, did: DID });
  const { container } = render(<BlueskyEmbed href="https://bsky.app/profile/alice.bsky.social" />);
  expect(container).toBeEmptyDOMElement();
});

// --- actor/height identity reconciliation (pkm-stn6) ---

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

  // alpha's stale resolution arrives late; the href has moved on, so it must not be adopted.
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
  expect(container.querySelector<HTMLIFrameElement>("iframe.bluesky-embed")!.style.height).toBe("700px");

  rerender(<BlueskyEmbed href={hrefB} />);
  expect(container.querySelector<HTMLIFrameElement>("iframe.bluesky-embed")!.style.height).toBe("");
});

it("resolves the DID for a valid href after starting from an invalid href", () => {
  const validHref = `https://bsky.app/profile/${DID}/post/valid123`;
  const { container, rerender } = render(<BlueskyEmbed href="https://bsky.app/profile/alice.bsky.social" />);
  expect(container).toBeEmptyDOMElement();

  rerender(<BlueskyEmbed href={validHref} />);
  expect(container.querySelector("iframe.bluesky-embed")).not.toBeNull();
  expect(embedSrc(container)?.pathname).toBe(`/embed/${DID}/app.bsky.feed.post/valid123`);
});
