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

// A class's declarations can live in more than one rule -- .search-field-input
// carries the colours it shares with .input-control in one rule and its own
// geometry in another. ruleFor returns only the first match, so collect every
// rule whose selector text names this one.
function rulesFor(selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const bodies = [...styles.matchAll(
    new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g"))].map((m) => m[1]);
  if (bodies.length === 0) throw new Error(`Missing CSS rule for ${selector}`);
  return bodies.join("\n");
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
  // the pill moved to the shared .search-field-input class (pkm-0wg9) so the
  // /files search is the same object, not a lookalike
  test("the search input is a rounded pill", () => {
    expect(rulesFor(".search-field-input"))
      .toContain("border-radius: var(--radius-pill);");
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
    // border lightened and the radius became a pill in pkm-0wg9
    expect(btn).toContain("border: 1px solid var(--color-border);");
    expect(btn).toContain("border-radius: var(--radius-pill);");
    expect(ruleFor(".show-more")).not.toContain("background:");
    expect(ruleFor(".composer-send")).not.toContain("background:");
  });

  test("light-mode bullets are a step darker so outline structure reads", () => {
    const root = ruleFor(":root");
    expect(root).toContain("--color-bullet: #d2e0ea;");
    expect(root).toContain("--color-bullet-ring: #c6d7e3;");
  });
});

describe("form control tokens (pkm-mrru)", () => {
  test("the button tokens carry their own geometry, so bare call sites look right", () => {
    for (const selector of [".btn-secondary", ".btn-danger"]) {
      // widened for the pill shape in pkm-0wg9
      expect(ruleFor(selector)).toContain("padding: 5px 14px;");
    }
  });

  test("owning classes no longer restate the shared button padding", () => {
    expect(ruleFor(".show-more")).not.toContain("padding:");
  });

  test("text inputs and selects share one .input-control style", () => {
    // colours live in the grouped rule shared with .search-field-input
    // (pkm-0wg9); this class keeps its own geometry
    const shared = ruleFor(".input-control, .search-field-input");
    expect(shared).toContain("font: inherit;");
    expect(shared).toContain("color: var(--color-text);");
    const input = ruleFor(".input-control");
    expect(input).toContain("padding: 5px 9px;");
    expect(input).toContain("border-radius: var(--radius-field);");
  });

  test("the input token has a visible keyboard focus ring", () => {
    expect(ruleFor(".input-control:focus-visible"))
      .toContain("outline: 2px solid var(--color-link);");
  });

  // Without this, Chrome paints select/date widgets, their popups, and
  // scrollbars in light mode however the author styles them (pkm-mrru).
  test("each theme declares its colour scheme for native widgets", () => {
    expect(ruleFor(":root")).toContain("color-scheme: light;");
    expect(ruleFor(':root:not([data-theme="light"])'))
      .toContain("color-scheme: dark;");
    expect(ruleFor(':root[data-theme="dark"]'))
      .toContain("color-scheme: dark;");
  });
});

describe("control polish (pkm-0wg9)", () => {
  test("actions and fields have their own radius tokens", () => {
    const root = ruleFor(":root");
    expect(root).toContain("--radius-pill: 999px;");
    expect(root).toContain("--radius-field: 7px;");
    // unchanged: inline code, block rows, badges and thumbs still use it
    expect(root).toContain("--radius-control: 4px;");
  });

  test("buttons are pills with hover and focus feedback", () => {
    const btn = ruleFor(".btn-secondary");
    expect(btn).toContain("border-radius: var(--radius-pill);");
    expect(btn).toContain("padding: 5px 14px;");
    expect(btn).toContain("border: 1px solid var(--color-border);");
    expect(btn).toContain("transition:");
    expect(ruleFor(".btn-danger")).toContain("border-radius: var(--radius-pill);");
    expect(ruleFor(".btn-secondary:hover:not(:disabled)"))
      .toContain("border-color: var(--color-border-strong);");
    expect(ruleFor(".btn-secondary:focus-visible, .btn-danger:focus-visible"))
      .toContain("outline: 2px solid var(--color-link);");
  });

  test("compact pill call sites get enough horizontal room", () => {
    expect(ruleFor(".reference-link-button")).toContain("padding: 1px 10px;");
    expect(rulesFor(".composer-send")).toContain("padding: 6px 14px;");
  });

  test("the assistant send button does not stretch into a lozenge", () => {
    expect(ruleFor(".assistant-input .btn-secondary"))
      .toContain("align-self: flex-end;");
  });

  test("the danger button fills with a token tuned for fills, not text", () => {
    const danger = ruleFor(".btn-danger");
    expect(danger).toContain("background: var(--color-error-fill);");
    expect(danger).toContain("border: 1px solid var(--color-error-fill);");
    // light keeps today's red; dark gets a deep red instead of coral
    expect(ruleFor(":root")).toContain("--color-error-fill: #c23030;");
    expect(ruleFor(':root:not([data-theme="light"])'))
      .toContain("--color-error-fill: #a83a3a;");
    expect(ruleFor(':root[data-theme="dark"]'))
      .toContain("--color-error-fill: #a83a3a;");
    // --color-error keeps its own job: error text and the failed badge
    expect(ruleFor(".error")).toContain("color: var(--color-error);");
  });

  test("fields share one look, modelled on the Cmd-U search", () => {
    // one grouped rule so the two searches cannot drift apart; each class then
    // adds its own geometry
    const field = ruleFor(".input-control, .search-field-input");
    expect(field).toContain("background: var(--color-bg-subtle);");
    expect(field).toContain("border: 1px solid var(--color-border-strong);");
    expect(field).toContain("transition:");
    const focus = ruleFor(".input-control:focus, .search-field-input:focus");
    expect(focus).toContain("background: var(--color-bg-surface);");
    expect(focus).toContain("border-color: var(--color-border-input);");
    expect(ruleFor(".input-control"))
      .toContain("border-radius: var(--radius-field);");
  });

  test("bespoke field rules keep layout only, not colours", () => {
    for (const selector of [".nav-sidebar-add input",
                            ".assistant-input textarea"]) {
      const rule = ruleFor(selector);
      expect(rule).not.toContain("background:");
      expect(rule).not.toContain("border:");
      expect(rule).not.toContain("border-radius:");
    }
    expect(ruleFor(".composer textarea")).not.toContain("border:");
  });

  // the outline editor is a writing surface, not a form field
  test("the block editor gains no field chrome", () => {
    const editor = ruleFor(".block-input");
    expect(editor).not.toContain("background: var(--color-bg-subtle);");
    expect(editor).not.toContain("border: 1px solid");
    // positive form: the writing surface is explicitly chrome-less, not merely
    // missing the field colours
    expect(editor).toContain("background: transparent;");
    expect(editor).toContain("border: none;");
  });

  test("the search field look is shared, not duplicated per call site", () => {
    expect(ruleFor(".search-field")).toContain("position: relative;");
    expect(ruleFor(".search-field-icon")).toContain("position: absolute;");
    const input = rulesFor(".search-field-input");
    expect(input).toContain("border-radius: var(--radius-pill);");
    expect(input).toContain("padding: 4px 12px 4px 30px;");
    // both searches share the field colours
    expect(styles).toContain(".input-control, .search-field-input {");
  });

  test("the top bar keeps only its own width behaviour", () => {
    const topBar = ruleFor(".top-bar-search-input");
    expect(topBar).toContain("width: 220px;");
    expect(topBar).toContain("transition: width 0.15s");
    expect(topBar).not.toContain("border-radius:");
    expect(ruleFor(".top-bar-search-input:focus")).toContain("width: 320px;");
    // pkm-absu: the hint chip hides via an adjacent-sibling selector, so the
    // kbd must stay immediately after the input
    expect(styles).toContain(".top-bar-search-input:focus + .top-bar-search-hint,");
  });

  test("ghost icon buttons get a round hover chip", () => {
    const ghost = ruleFor(
      ".top-bar-menu-button, .sidebar-toggle-button, .help-button");
    expect(ghost).toContain("border-radius: var(--radius-pill);");
    // pkm-absu: transparent border, not none, so hover doesn't shift layout
    expect(ghost).toContain("border: 1px solid transparent;");
  });

  // /files' search doesn't grow on focus the way the top bar does, so it keeps
  // the field family's ring; the top bar explicitly opts out again
  test("the non-growing search keeps a visible focus ring", () => {
    expect(ruleFor(".search-field-input:focus-visible"))
      .toContain("outline: 2px solid var(--color-link);");
    expect(ruleFor(".top-bar-search-input:focus-visible"))
      .toContain("outline: none;");
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

describe("top bar page menu (pkm-ciy8)", () => {
  test("menu buttons and the export-as-markdown anchor share the same weight", () => {
    const item = ruleFor(".top-bar-menu button, .top-bar-menu a");
    expect(item).toContain("font-weight: normal;");
    expect(item).toContain("text-decoration: none;");
    expect(item).toContain("color: var(--color-text);");
  });
});

describe("full-width layout margins (pkm-5nif)", () => {
  test("the no-sidebar case keeps a wider gutter than the other combinations", () => {
    const noSidebar = ruleFor(".app.nav-collapsed.no-sidebar .content-area");
    expect(noSidebar).toContain("min(1240px, calc(100% - 160px))");
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
