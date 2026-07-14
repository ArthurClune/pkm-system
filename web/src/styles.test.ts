// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const stylesPath = fileURLToPath(new URL("./styles.css", import.meta.url));
const styles = readFileSync(stylesPath, "utf8");

function ruleFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1];
}

describe("outline line spacing", () => {
  test("uses 1.4 line-height for block rows and numbered bullets", () => {
    expect(ruleFor(".block-row")).toContain("line-height: 1.4;");
    expect(ruleFor(".bullet.numbered")).toContain("line-height: 1.4;");
  });
});

describe("link styling (pkm-1eaj)", () => {
  test("page links are medium weight, not bold", () => {
    expect(ruleFor("a.page-link")).toContain("font-weight: 500;");
  });

  test("nav links are muted by default and accent-coloured when active", () => {
    expect(ruleFor(".nav-link")).toContain("color: var(--color-text-secondary);");
    expect(ruleFor(".nav-link.active")).toContain("color: var(--color-accent);");
  });

  test("link colour is its own token, calmer than the accent", () => {
    const root = ruleFor(":root");
    const link = root.match(/--color-link: (#[0-9a-fA-F]+);/)?.[1];
    const accent = root.match(/--color-accent: (#[0-9a-fA-F]+);/)?.[1];
    expect(link).toBeDefined();
    expect(accent).toBeDefined();
    expect(link).not.toBe(accent);
  });
});

describe("typography hierarchy (pkm-b68q)", () => {
  test("heading blocks scale clearly below the page title", () => {
    expect(ruleFor("h1.block-text")).toContain("font-size: 1.4rem;");
    expect(ruleFor("h2.block-text")).toContain("font-size: 1.25rem;");
    expect(ruleFor("h3.block-text")).toContain("font-size: 1.1rem;");
  });

  test("h3 heading blocks are not de-emphasised below body text", () => {
    const h3 = ruleFor("h3.block-text");
    expect(h3).not.toContain("font-weight: 400;");
    expect(h3).not.toContain("color: var(--color-text-secondary);");
  });
});
