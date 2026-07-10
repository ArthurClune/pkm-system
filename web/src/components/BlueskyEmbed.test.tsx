import { render } from "@testing-library/react";
import { expect, it } from "vitest";
import { BlueskyEmbed, blueskyEmbedSrc, isBlueskyPostUrl, parseBlueskyPostUrl } from "./BlueskyEmbed";

it("parses a handle-based post URL into actor and rkey", () => {
  expect(parseBlueskyPostUrl("https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy"))
    .toEqual({ actor: "alice.bsky.social", rkey: "3k2abc123xy" });
});

it("parses a DID-based post URL", () => {
  expect(parseBlueskyPostUrl("https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/post/3k2abc123xy"))
    .toEqual({ actor: "did:plc:z72i7hdynmk6r22z27h6tvur", rkey: "3k2abc123xy" });
});

it("rejects bsky.app URLs that are not a post", () => {
  expect(parseBlueskyPostUrl("https://bsky.app/profile/alice.bsky.social")).toBeNull();
  expect(parseBlueskyPostUrl("https://bsky.app/search")).toBeNull();
  expect(parseBlueskyPostUrl("https://bsky.app/")).toBeNull();
});

it("rejects post URLs missing an rkey", () => {
  expect(parseBlueskyPostUrl("https://bsky.app/profile/alice.bsky.social/post/")).toBeNull();
});

it("rejects non-bsky.app hosts, including lookalike domains", () => {
  expect(parseBlueskyPostUrl("https://bsky.app.evil.com/profile/alice.bsky.social/post/3k2abc123xy")).toBeNull();
  expect(parseBlueskyPostUrl("https://evil.com/profile/alice.bsky.social/post/3k2abc123xy")).toBeNull();
});

it("rejects non-https schemes", () => {
  expect(parseBlueskyPostUrl("http://bsky.app/profile/alice.bsky.social/post/3k2abc123xy")).toBeNull();
});

it("isBlueskyPostUrl mirrors parseBlueskyPostUrl", () => {
  expect(isBlueskyPostUrl("https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy")).toBe(true);
  expect(isBlueskyPostUrl("https://bsky.app/profile/alice.bsky.social")).toBe(false);
});

it("builds an embed.bsky.app iframe src carrying the original URL as ref_url", () => {
  const href = "https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy";
  expect(blueskyEmbedSrc(href)).toBe(
    "https://embed.bsky.app/embed/alice.bsky.social/app.bsky.feed.post/3k2abc123xy" +
      "?ref_url=https%3A%2F%2Fbsky.app%2Fprofile%2Falice.bsky.social%2Fpost%2F3k2abc123xy",
  );
});

it("returns null for non-post URLs", () => {
  expect(blueskyEmbedSrc("https://bsky.app/profile/alice.bsky.social")).toBeNull();
});

it("renders an iframe pointed at the embed.bsky.app src", () => {
  const href = "https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy";
  const { container } = render(<BlueskyEmbed href={href} />);
  const iframe = container.querySelector("iframe.bluesky-embed");
  expect(iframe).not.toBeNull();
  expect(iframe).toHaveAttribute("src", blueskyEmbedSrc(href)!);
});

it("renders nothing for a non-post href", () => {
  const { container } = render(<BlueskyEmbed href="https://bsky.app/profile/alice.bsky.social" />);
  expect(container).toBeEmptyDOMElement();
});
