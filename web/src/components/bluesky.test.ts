import { expect, it } from "vitest";
import { blueskyEmbedSrc, isBlueskyPostUrl, parseBlueskyPostUrl } from "./bluesky";

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

it("builds the iframe src from the resolved DID, not the URL's actor", () => {
  const href = "https://bsky.app/profile/alice.bsky.social/post/3k2abc123xy";
  expect(blueskyEmbedSrc(href, "did:plc:z72i7hdynmk6r22z27h6tvur", "77")).toBe(
    "https://embed.bsky.app/embed/did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.post/3k2abc123xy" +
      "?id=77&ref_url=https%3A%2F%2Fbsky.app%2Fprofile%2Falice.bsky.social%2Fpost%2F3k2abc123xy",
  );
});

it("returns null for non-post URLs", () => {
  expect(blueskyEmbedSrc("https://bsky.app/profile/alice.bsky.social", "did:plc:x", "77")).toBeNull();
});
