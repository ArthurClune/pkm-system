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

// Rules inside an @media block are invisible to ruleFor/rulesFor: both stop at
// the first "}", which is the end of the block's first nested rule. Slice the
// query's blocks out by balancing braces, then match rules within that text.
function mediaRulesFor(query: string, selector: string): string {
  const marker = `@media ${query} {`;
  const blocks: string[] = [];
  for (let from = 0; ; ) {
    const start = styles.indexOf(marker, from);
    if (start === -1) break;
    let depth = 1;
    let end = start + marker.length;
    while (end < styles.length && depth > 0) {
      if (styles[end] === "{") depth++;
      else if (styles[end] === "}") depth--;
      end++;
    }
    blocks.push(styles.slice(start + marker.length, end - 1));
    from = end;
  }
  if (blocks.length === 0) throw new Error(`Missing @media ${query}`);
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`, "g");
  const bodies = blocks.flatMap(
    (block) => [...block.matchAll(pattern)].map((m) => m[1]));
  if (bodies.length === 0) {
    throw new Error(`Missing CSS rule for ${selector} in @media ${query}`);
  }
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
    expect(rulesFor(".top-bar")).toContain("padding: 8px 16px 8px 52px;");
  });
});

describe("ghost icon button focus ring (pkm-cq32)", () => {
  test("top-bar ghost buttons get the themed keyboard focus ring", () => {
    const focus = ruleFor(
      ".top-bar-menu-button:focus-visible, .sidebar-toggle-button:focus-visible, .help-button:focus-visible",
    );
    expect(focus).toContain("outline: 2px solid var(--color-link);");
    // the transparent border is pkm-absu's no-shift-on-hover guard; the ring
    // must not require touching it
    expect(ruleFor(".top-bar-menu-button, .sidebar-toggle-button, .help-button"))
      .toContain("border: 1px solid transparent;");
  });

  // found by tabbing the live app: .nav-link is on both the <a> destinations
  // and the <button> controls in the left nav, which are the app's first eight
  // tab stops -- all of them were showing Chrome's default ring
  test("the left nav links and controls get the ring", () => {
    expect(ruleFor(".nav-link:focus-visible"))
      .toContain("outline: 2px solid var(--color-link);");
  });

  test("the page-menu dropdown items get the ring too", () => {
    expect(ruleFor(".top-bar-menu button:focus-visible, .top-bar-menu a:focus-visible"))
      .toContain("outline: 2px solid var(--color-link);");
  });

  // other bare <button> classes found by the pkm-cq32 audit -- same gap,
  // same fix
  test("other bare-button classes audited for the same gap all get the ring", () => {
    for (const selector of [
      ".chevron",
      ".panel-close",
      ".hamburger",
      ".block-menu-item",
      ".empty-page",
      ".assistant-close",
      ".assistant-preview-toggle",
      ".page-title-edit",
      ".section-toggle",
    ]) {
      expect(ruleFor(`${selector}:focus-visible`))
        .toContain("outline: 2px solid var(--color-link);");
    }
  });

  // The bullet is a real menu button (role=button, tabIndex 0, Enter/Space/
  // Shift+F10 -> block menu) and the only keyboard route to that menu, so it
  // keeps its tab stop. It needs the themed ring for a second reason beyond
  // the palette clash: .bullet.closed marks collapsed-with-hidden-children by
  // colouring the bullet's own 4px border, and Chrome's default ring is also
  // drawn tight around the dot, so a focused bullet read as collapsed
  // (pkm-scgu). --color-link at an offset tells the two apart.
  test("the block bullet gets the themed ring, not Chrome's collapsed-lookalike", () => {
    const focus = ruleFor(".bullet:focus-visible");
    expect(focus).toContain("outline: 2px solid var(--color-link);");
    expect(focus).toContain("outline-offset:");
    // the .closed ring lives on the border; the focus ring must sit outside it
    expect(ruleFor(".bullet.closed")).toContain("border-color: var(--color-bullet-ring);");
  });

  // deliberate exclusion, so a later audit doesn't "fix" it back: the date
  // picker is mouse-only by design (pkm-rw6w) -- its buttons preventDefault on
  // mousedown so they never take focus, and Tab inside a block indents instead
  // of moving focus, so a ring there could never be seen.
  test("the mouse-only date picker is left without a ring", () => {
    expect(styles).not.toContain(".date-picker-day:focus-visible");
    expect(styles).not.toContain(".date-picker-header button:focus-visible");
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

describe("shared Files styling (pkm-6phf findings 16-17)", () => {
  test("settings-note styling is available outside Settings sections", () => {
    expect(styles).toContain("\np.settings-note {");
    expect(styles).not.toContain(".settings-section p.settings-note");

    const note = ruleFor("p.settings-note");
    expect(note).toContain("font-size: 13px;");
    expect(note).toContain("color: var(--color-text-muted);");
    expect(note).toContain("margin-top: 6px;");
  });

  test("disabled danger buttons match secondary disabled feedback", () => {
    expect(ruleFor(".btn-danger:hover:not(:disabled)"))
      .toContain("opacity: 0.9;");
    expect(styles).not.toContain(".btn-danger:hover {");

    const disabled = ruleFor(".btn-danger:disabled");
    expect(disabled).toContain("opacity: 0.35;");
    expect(disabled).toContain("cursor: default;");
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
      expect(rule).not.toContain("border:");
      expect(rule).not.toContain("border-radius:");
    }
    expect(ruleFor(".assistant-input textarea")).not.toContain("background:");
    expect(ruleFor(".composer textarea")).not.toContain("border:");
  });

  // the one background exception (pkm-k1ak): .left-nav is itself
  // --color-bg-subtle, so the shared resting fill leaves this field with only
  // its border to distinguish it from the nav
  test("the sidebar Add field lifts off the nav background", () => {
    expect(ruleFor(".left-nav")).toContain("background: var(--color-bg-subtle);");
    expect(ruleFor(".nav-sidebar-add input"))
      .toContain("background: var(--color-bg-surface);");
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
  // The trigger's width cap belongs to pkm-1vq4 below, not here.
  test("the uploaded-image trigger preserves layout and has visible keyboard focus", () => {
    const trigger = ruleFor(".asset-image-trigger");
    expect(trigger).toContain("display: block;");
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

describe("embedded image size (pkm-1vq4)", () => {
  test("an embedded image spans at most two-thirds of the text column", () => {
    // Bare <img> (external URLs) and the /assets/ trigger button both need the
    // cap: whichever one is the outermost box decides the rendered width.
    expect(ruleFor(".asset-image")).toContain("max-width: 67%;");
    expect(ruleFor(".asset-image-trigger")).toContain("max-width: 67%;");
  });

  test("a wrapped image fills its trigger so the cap is not applied twice", () => {
    expect(ruleFor(".asset-image-trigger .asset-image"))
      .toContain("max-width: 100%;");
  });

  test("phones keep embedded images full width", () => {
    expect(mediaRulesFor("(max-width: 600px)", ".asset-image"))
      .toContain("max-width: 100%;");
    expect(mediaRulesFor("(max-width: 600px)", ".asset-image-trigger"))
      .toContain("max-width: 100%;");
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

describe("left-nav section separator (pkm-usb6)", () => {
  test("the pinned-page list and the link below it are fenced the same way", () => {
    // The pinned list draws the upper rule; .nav-section-start draws the
    // matching lower one, and must out-pad .nav-link's own 4px so its text
    // clears the rule by the same 12px the first pinned entry does.
    const entries = ruleFor(".nav-sidebar-entries");
    expect(entries).toContain("border-top: 1px solid var(--color-border);");
    const section = ruleFor(".nav-section-start");
    expect(section).toContain("border-top: 1px solid var(--color-border);");
    expect(section).toContain("padding-top: 12px;");
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

describe("phone nav drawer is unreachable while closed (pkm-rwwp)", () => {
  test("the closed drawer is visibility:hidden; .open restores it", () => {
    // translateX alone leaves every nav link tabbable off-screen, and they are
    // the page's first tab stops. visibility:hidden takes the whole subtree
    // out of the focus order.
    const closed = mediaRulesFor("(max-width: 600px)", ".left-nav");
    expect(closed).toContain("visibility: hidden;");
    // transitioned, so the slide-out is still seen: a visibility transition
    // holds "visible" until the end when moving to hidden
    expect(closed).toContain("transition: transform 0.15s, visibility 0.15s;");
    expect(mediaRulesFor("(max-width: 600px)", ".left-nav.open"))
      .toContain("visibility: visible;");
  });
});

describe("in-heading trigger buttons inherit their heading (pkm-l4z8)", () => {
  test("the page-title edit button carries no button chrome", () => {
    const rule = rulesFor(".page-title-edit");
    expect(rule).toContain("font: inherit;");
    // font: inherit does not carry letter-spacing, and .page-title sets it
    expect(rule).toContain("letter-spacing: inherit;");
    expect(rule).toContain("border: none;");
    expect(rule).toContain("background: none;");
    expect(rule).toContain("cursor: text;");
  });

  test("the collapsible section toggle keeps the header's uppercase type", () => {
    const rule = rulesFor(".section-toggle");
    expect(rule).toContain("font: inherit;");
    expect(rule).toContain("text-transform: inherit;");
    expect(rule).toContain("letter-spacing: inherit;");
    expect(rule).toContain("border: none;");
    expect(rule).toContain("background: none;");
  });

  // Regression: an inline-block button sized to its chevron+text left a wide
  // dead zone across the rest of the header row where the old <h2 onClick>
  // used to respond -- clicking there silently did nothing (caught by
  // link-reference.spec.ts, not by a unit test, since jsdom has no layout).
  test("the section toggle spans the full header, matching the page-title edit button", () => {
    const rule = rulesFor(".section-toggle");
    expect(rule).toContain("display: block;");
    expect(rule).toContain("width: 100%;");
  });
});

describe("focused search stays inside narrow phone viewports (pkm-vszf)", () => {
  // Desktop's fixed 220px/320px growth (pkm-0wg9) is untouched -- only the
  // phone breakpoint gets a shrinkable field. jsdom can't lay out flexbox, so
  // the actual "stays on screen" claim is Playwright's job
  // (e2e/search-viewport.spec.ts); this only pins the declarations down.
  test("desktop keeps its fixed focused width", () => {
    const topBar = ruleFor(".top-bar-search-input");
    expect(topBar).toContain("width: 220px;");
    expect(ruleFor(".top-bar-search-input:focus")).toContain("width: 320px;");
  });

  test("the phone breakpoint lets the search field shrink instead of overflowing", () => {
    // .search-field is the flex item that actually overflowed: with no
    // min-width override a flex item won't shrink below its content's
    // (here, the 320px-wide focused input's) size, so min-width: 0 is what
    // lets the flex algorithm actually squeeze it down to what's left.
    expect(mediaRulesFor("(max-width: 600px)", ".search-field"))
      .toContain("min-width: 0;");
  });

  test("the phone breakpoint restores a themed focus ring", () => {
    // Desktop signals focus by growing the field; once growth is capped by
    // available space that cue may be too subtle to read, so the ring the
    // field family normally carries (and the top bar opts out of, pkm-0wg9)
    // comes back at this breakpoint.
    expect(mediaRulesFor("(max-width: 600px)", ".top-bar-search-input:focus-visible"))
      .toContain("outline: 2px solid var(--color-link);");
  });
});

describe("block stamps (pkm-4ler)", () => {
  const BANDS = ["week", "month", "year"] as const;

  test("the three tinted age-band tokens exist in all three theme blocks", () => {
    const blocks = [
      ruleFor(":root"),
      ruleFor(':root:not([data-theme="light"])'),
      ruleFor(':root[data-theme="dark"]'),
    ];
    for (const body of blocks) {
      for (const band of BANDS) {
        expect(body).toMatch(new RegExp(`--color-stamp-${band}: #[0-9a-fA-F]{6};`));
      }
    }
  });

  test("light and dark values differ for every tinted band", () => {
    const light = ruleFor(":root");
    const dark = ruleFor(':root[data-theme="dark"]');
    for (const band of BANDS) {
      const pattern = new RegExp(`--color-stamp-${band}: (#[0-9a-fA-F]{6});`);
      expect(light.match(pattern)?.[1]).not.toBe(dark.match(pattern)?.[1]);
    }
  });

  test("each tinted band class fills with its own token", () => {
    for (const band of BANDS) {
      expect(rulesFor(`.block-stamp-${band}`))
        .toContain(`background: var(--color-stamp-${band});`);
    }
  });

  // The user's verdict on the running app: in a mature database most rows
  // are "older", so painting ink behind the commonest rows is backwards --
  // only genuinely recent-ish material should carry a tint. This must stay
  // true even if someone reaches for a fourth token again later.
  test("the older band is deliberately left untinted", () => {
    expect(styles).not.toMatch(/--color-stamp-older\s*:/);
    expect(styles).not.toMatch(/\.block-stamp-older\s*\{[^}]*background\s*:/);
    // .block-stamp's own body is what makes an unstyled older cell render
    // with no fill at all.
    expect(rulesFor(".block-stamp")).toContain("background: none;");
  });

  test("the cell is a fixed-width right-aligned column that never wraps", () => {
    const body = rulesFor(".block-stamp");
    // Fixed width, not content width: the stamps must form a true column
    // rather than tracking each row's text length.
    expect(body).toMatch(/flex: 0 0 \d+px;/);
    expect(body).toContain("text-align: right;");
    expect(body).toContain("white-space: nowrap;");
  });

  test("the column is hidden on phones", () => {
    expect(mediaRulesFor("(max-width: 600px)", ".block-stamp"))
      .toContain("display: none;");
  });

  // Deliberately no reserved-checkmark slot in this menu (BlockMenu keeps its
  // own): a 1.25em indent wrapped "Show timestamps" onto two lines while every
  // sibling sat flush, so the item flips its label instead. A rule reappearing
  // here would mean the two idioms had been mixed back together.
  test("the page menu reserves no checkmark slot", () => {
    expect(() => rulesFor(".top-bar-menu-check")).toThrow(/Missing CSS rule/);
  });

  // The menu shrink-to-fits against a button-sized parent, so its width sits at
  // min-content -- the widest word -- unless the items refuse to wrap.
  test("page-menu items never wrap their labels", () => {
    expect(rulesFor(".top-bar-menu button, .top-bar-menu a"))
      .toContain("white-space: nowrap;");
  });
});

describe("reference-count gutter badge (pkm-d31f)", () => {
  test("is a muted pill styled from the two tokens", () => {
    const rule = rulesFor(".block-ref-badge");
    expect(rule).toContain("color: var(--color-text-muted);");
    expect(rule).toContain("background: var(--color-bg-subtle);");
  });

  // unlike .block-stamp, the badge must NOT be display:none on phones -- it
  // is the only route to the popover on touch. There is currently no phone
  // override at all, so the base (visible) rule keeps applying there; the
  // invariant is "not hidden", not "no rule ever" -- a future phone rule
  // (e.g. a bigger touch target) shouldn't fail this test on its own.
  test("survives the phone media query", () => {
    let phoneRule = "";
    try {
      phoneRule = mediaRulesFor("(max-width: 600px)", ".block-ref-badge");
    } catch {
      return; // no phone rule at all -- base rule stays visible
    }
    expect(phoneRule).not.toContain("display: none");
  });

  test("gets the standard keyboard focus ring", () => {
    expect(ruleFor(".block-ref-badge:focus-visible"))
      .toContain("outline: 2px solid var(--color-link);");
  });
});

describe("references popover (pkm-d31f)", () => {
  // layers and shades like .block-menu -- both are fixed-position floating
  // panels that can be open at the same time (a badge inside a block menu's
  // context is unlikely, but nothing rules it out), so they share tokens.
  test("shares .block-menu's layering and surface treatment", () => {
    const menu = ruleFor(".block-menu");
    const popover = ruleFor(".block-ref-popover");
    expect(popover).toContain("z-index: 60;");
    expect(menu).toContain("z-index: 60;");
    expect(popover).toContain("border-radius: var(--radius-panel);");
    expect(popover).toContain("box-shadow: 0 4px 14px rgba(var(--shadow-rgb), 0.15);");
    expect(menu).toContain("box-shadow: 0 4px 14px rgba(var(--shadow-rgb), 0.15);");
  });

  test("caps its own height with a vertical scrollbar, never the page's horizontal", () => {
    const rule = ruleFor(".block-ref-popover");
    expect(rule).toContain("max-height: 60vh;");
    expect(rule).toContain("overflow-y: auto;");
  });

  test("navigable backlink items get a pointer cursor and hover fill", () => {
    expect(ruleFor(".backlink-item.navigable")).toContain("cursor: pointer;");
    expect(ruleFor(".backlink-item.navigable:hover"))
      .toContain("background: var(--color-bg-subtle);");
  });
});

describe("PDF frame contributes no baseline (pkm-vg3y)", () => {
  // .block-row aligns its items by baseline. WebKit (iPadOS Safari) took the
  // block-text's first baseline from the bottom edge of the page-1 canvas
  // INSIDE the overflow:auto frame -- 760px down, past the frame's 480px clip
  // -- and, because content changes inside a scroller never re-ran the row's
  // flex layout, the row stayed stretched to that height until something else
  // forced a relayout. Layout containment makes the frame baseline-less by
  // spec, so the row's baseline always comes from the footer text instead.
  test("the inline frame is layout-contained", () => {
    expect(rulesFor(".pdf-frame")).toMatch(/contain:\s*layout/);
  });
  test("nothing position:fixed is declared for the frame's own content", () => {
    // the containment invariant in styling.md: the overlay is portalled to
    // body, so the frame must not gain a fixed-position descendant rule
    expect(rulesFor(".pdf-frame")).not.toMatch(/position:\s*fixed/);
    expect(rulesFor(".pdf-page-slot")).not.toMatch(/position:\s*fixed/);
  });
});

// Refs into a few big page trees get their own colour so [[AWS/EC2]] and
// [[Project/SITS]] read as different kinds of link at a glance (pkm-r71a).
describe("namespace link colours (pkm-r71a)", () => {
  const TOKENS = ["--color-link-cloud", "--color-link-ai",
    "--color-link-work", "--color-link-reading"];
  const GROUPS: Record<string, string[]> = {
    "--color-link-cloud": ["aws", "azure", "gcp"],
    "--color-link-ai": ["claude", "llm"],
    "--color-link-work": ["project", "uos"],
    "--color-link-reading": ["paper", "book", "article"],
  };

  // Selector lists share one body, so ruleFor's "selector then {" shape
  // misses every entry but the last; match from the entry to the next "{".
  function nsRule(ns: string): string {
    const m = styles.match(
      new RegExp(`a\\.page-link\\[data-ns="${ns}"\\][^{]*\\{([^}]*)\\}`));
    if (!m) throw new Error(`Missing CSS rule for data-ns="${ns}"`);
    return m[1];
  }

  test("each group token is defined in light and both dark blocks", () => {
    for (const token of TOKENS) {
      expect(ruleFor(":root")).toMatch(new RegExp(`${token}: #[0-9a-fA-F]{6};`));
      expect(ruleFor(':root:not([data-theme="light"])'))
        .toMatch(new RegExp(`${token}: #[0-9a-fA-F]{6};`));
      expect(ruleFor(':root[data-theme="dark"]'))
        .toMatch(new RegExp(`${token}: #[0-9a-fA-F]{6};`));
    }
  });

  test("group tokens are distinct from each other and from the plain link", () => {
    const root = ruleFor(":root");
    const values = [...TOKENS, "--color-link", "--color-link-ext"].map((t) =>
      root.match(new RegExp(`${t}: (#[0-9a-fA-F]{6});`))?.[1]);
    expect(new Set(values).size).toBe(values.length);
  });

  test("every namespace in a group is coloured with that group's token", () => {
    for (const [token, namespaces] of Object.entries(GROUPS)) {
      for (const ns of namespaces) {
        expect(nsRule(ns)).toContain(`color: var(${token});`);
      }
    }
  });

  test("attribute names stay muted even when their page is namespaced", () => {
    // .attribute a (0,1,1) would lose to a.page-link[data-ns=..] (0,2,1);
    // the attribute rule must name the attribute selector to keep winning.
    expect(styles).toMatch(
      /\.attribute a\.page-link\[data-ns\][^{]*\{[^}]*color: var\(--color-text-muted\);/);
  });
});
