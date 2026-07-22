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

  test("primary nav links (Daily Notes, Current Work) are always accent-coloured", () => {
    expect(ruleFor(".nav-link.primary")).toContain("color: var(--color-accent);");
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

describe("metadata chips (pkm-7t7o)", () => {
  test("attribute names are small-caps muted labels, not bold text", () => {
    const attr = ruleFor(".attribute a");
    expect(attr).toContain("font-variant-caps: all-small-caps;");
    expect(attr).toContain("color: var(--color-text-muted);");
    expect(attr).not.toContain("font-weight: 600;");
  });

  test("tags are rounded chips with a subtle background", () => {
    const tag = ruleFor("a.tag");
    expect(tag).toContain("background: var(--color-bg-subtle);");
    expect(tag).toContain("border-radius: 999px;");
    expect(tag).toContain("border: 1px solid var(--color-border-subtle);");
  });

  test("tag chips retain the tag colour on hover without underlining", () => {
    const hover = ruleFor("a.tag:hover");
    expect(hover).toContain("color: var(--color-tag);");
    expect(hover).toContain("text-decoration: none;");
  });
});

describe("top bar cohesion (pkm-absu)", () => {
  test("the search input is a rounded pill", () => {
    expect(ruleFor(".top-bar-search-input")).toContain("border-radius: 999px;");
  });

  test("the context label truncates and provides the bar's left/right split", () => {
    const title = ruleFor(".top-bar-title");
    expect(title).toContain("text-overflow: ellipsis;");
    expect(title).toContain("margin-right: auto;");
  });

  test("the shortcut hint hides while the input is focused or has text", () => {
    const hidden = ruleFor(
      ".top-bar-search-input:not(:placeholder-shown) + .top-bar-search-hint",
    );
    expect(hidden).toContain("display: none;");
    expect(styles).toContain(".top-bar-search-input:focus + .top-bar-search-hint,");
  });

  test("top-bar buttons share one ghost style", () => {
    const ghost = ruleFor(".top-bar-menu-button, .sidebar-toggle-button, .help-button");
    expect(ghost).toContain("border: 1px solid transparent;");
  });

  test("phone top bar clears the fixed hamburger button", () => {
    expect(styles).toContain("padding: 8px 16px 8px 52px;");
  });
});

describe("backlink card polish (pkm-mqvv)", () => {
  test("cards keep the subtle bg, drop the visible border, and tighten padding", () => {
    const card = ruleFor(".backlink-item, .query-item");
    expect(card).toContain("background: var(--color-bg-subtle);");
    expect(card).toContain("border: 1px solid transparent;");
    expect(card).toContain("padding: 6px 10px;");
  });

  test("cards get a hover state", () => {
    const hover = ruleFor(".backlink-item:hover, .query-item:hover");
    expect(hover).toContain("background: var(--color-selected-bg);");
  });

  test("breadcrumbs are legible (muted, not faint)", () => {
    expect(ruleFor(".breadcrumbs")).toContain("color: var(--color-text-muted);");
  });
});

describe("visual consistency (pkm-9kye)", () => {
  test("border-radius scale is tokenised and stray 3px radii are gone", () => {
    const root = ruleFor(":root");
    expect(root).toContain("--radius-control: 4px;");
    expect(root).toContain("--radius-card: 6px;");
    expect(root).toContain("--radius-panel: 8px;");
    expect(styles).not.toContain("border-radius: 3px;");
  });

  test("controls, cards, and panels use the radius tokens", () => {
    expect(ruleFor(".inline-code")).toContain("border-radius: var(--radius-control);");
    expect(ruleFor(".code-block")).toContain("border-radius: var(--radius-card);");
    expect(ruleFor(".backlink-item, .query-item")).toContain("border-radius: var(--radius-card);");
    expect(ruleFor(".main-pane")).toContain("border-radius: var(--radius-panel);");
    expect(ruleFor(".block-menu")).toContain("border-radius: var(--radius-panel);");
  });

  test("secondary buttons share one style definition", () => {
    const btn = ruleFor(".btn-secondary");
    expect(btn).toContain("background: var(--color-bg-subtle);");
    expect(btn).toContain("border: 1px solid var(--color-border-input);");
    expect(btn).toContain("border-radius: var(--radius-control);");
    expect(ruleFor(".show-more")).not.toContain("background:");
    expect(ruleFor(".composer-send")).not.toContain("background:");
  });

  test("light-mode bullets are a step darker so outline structure reads", () => {
    const root = ruleFor(":root");
    expect(root).toContain("--color-bullet: #d2e0ea;");
    expect(root).toContain("--color-bullet-ring: #c6d7e3;");
  });
});

describe("typography hierarchy (pkm-b68q, pkm-ofec)", () => {
  test("displayed and focused headings share the same scale and weight", () => {
    for (const [selector, size] of [
      ["h1.block-text, .block-input.heading-1", "1.4rem"],
      ["h2.block-text, .block-input.heading-2", "1.25rem"],
      ["h3.block-text, .block-input.heading-3", "1.1rem"],
    ] as const) {
      const rule = ruleFor(selector);
      expect(rule).toContain(`font-size: ${size};`);
      expect(rule).toContain("font-weight: 600;");
    }
  });

  test("h3 heading blocks are not de-emphasised below body text", () => {
    const h3 = ruleFor("h3.block-text, .block-input.heading-3");
    expect(h3).not.toContain("font-weight: 400;");
    expect(h3).not.toContain("color: var(--color-text-secondary);");
  });
});

describe("Roam tables (pkm-kbv5)", () => {
  test("wide tables scroll and cells use themed borders", () => {
    expect(ruleFor(".roam-table-scroll")).toContain("overflow-x: auto;");
    expect(ruleFor(".roam-table th, .roam-table td"))
      .toContain("border: 1px solid var(--color-border);");
    expect(ruleFor(".roam-table th")).toContain("text-align: left;");
  });
});

describe("uploaded image expansion (pkm-aze9)", () => {
  test("the uploaded-image trigger preserves layout and has visible keyboard focus", () => {
    const trigger = ruleFor(".asset-image-trigger");
    expect(trigger).toContain("display: block;");
    expect(trigger).toContain("max-width: 100%;");
    expect(trigger).toContain("cursor: zoom-in;");
    expect(ruleFor(".asset-image-trigger:focus-visible"))
      .toContain("outline: 2px solid var(--color-link);");
  });

  test("the overlay fills the viewport and the image is contained without cropping", () => {
    const overlay = ruleFor(".image-overlay");
    expect(overlay).toContain("position: fixed;");
    expect(overlay).toContain("inset: 0;");
    const image = ruleFor(".image-overlay-image");
    expect(image).toContain("max-width: 100%;");
    expect(image).toContain("max-height: 100%;");
    expect(image).toContain("object-fit: contain;");
  });
});

describe("unlinked reference Link action (pkm-965i)", () => {
  test("keeps text flexible and the compact action visible", () => {
    expect(ruleFor(".unlinked-link-row")).toContain("display: flex;");
    expect(ruleFor(".unlinked-link-row .backlink-text")).toContain("min-width: 0;");
    expect(ruleFor(".reference-link-button")).toContain("flex-shrink: 0;");
    expect(ruleFor(".reference-link-button")).toContain("font-size: 12px;");
  });
});
