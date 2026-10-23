import { expect, it } from "vitest";
import {
  asMermaidReadsEntities, refusesStockRender, STOCK_MERMAID_DOMPURIFY, STOCK_MERMAID_SECURE, stripCssImports,
} from "./mermaidSafety";

const A = "https://attacker.invalid";
const FM = "---\nconfig:\n  look: classic\n---\n";

it("keeps every secure key the installed mermaid secures by default", async () => {
  const { default: mermaid } = await import("mermaid");
  const defaults = mermaid.mermaidAPI.defaultConfig.secure ?? [];
  expect(defaults.length).toBeGreaterThan(0);
  expect(STOCK_MERMAID_SECURE).toEqual(expect.arrayContaining(defaults));
  expect(STOCK_MERMAID_SECURE).toEqual(expect.arrayContaining(
    ["themeCSS", "themeVariables", "fontFamily", "altFontFamily"]));
});

it("forbids the label tags and attributes that fetched in a probe", () => {
  expect(STOCK_MERMAID_DOMPURIFY.FORBID_TAGS).toEqual(
    expect.arrayContaining(["img", "image", "style"]));
  expect(STOCK_MERMAID_DOMPURIFY.FORBID_ATTR).toEqual(
    expect.arrayContaining(["style", "src", "srcset", "poster", "background", "filter"]));
});

it.each([
  ["an image shape", `flowchart TD\n  A@{ img: "${A}/s.png", label: "x" }`],
  ["an image shape over several lines", `flowchart TD\n  A@{\n    label: "x",\n    img: "${A}/s.png"\n  }`],
  ["a YAML-escaped image key", `flowchart TD\n  A@{ "\\x69mg": "${A}/s.png" }`],
  ["a classDef url()", `${FM}stateDiagram-v2\n  classDef c background-image:url(//attacker.invalid/x)`],
  ["an uppercase URL()", `${FM}stateDiagram-v2\n  classDef c background:URL(//attacker.invalid/x)`],
  ["a CSS-escaped url", `${FM}stateDiagram-v2\n  classDef c background-image:\\75rl(//attacker.invalid/x)`],
  ["a mermaid-entity paren", `${FM}stateDiagram-v2\n  classDef c background-image:url#40;//attacker.invalid/x);`],
  ["an HTML-entity paren", `${FM}stateDiagram-v2\n  classDef c background-image:url&#40;//attacker.invalid/x)`],
  ["a hex HTML-entity letter", `${FM}stateDiagram-v2\n  classDef c background-image:&#x75;rl(//attacker.invalid/x)`],
  ["a named-entity paren", `${FM}stateDiagram-v2\n  classDef c background-image:url&lpar;//attacker.invalid/x)`],
  ["a mermaid named entity", 'flowchart TD\n  A["url#lpar;x)"] --> B'],
  ["an entity that decodes to another", 'flowchart TD\n  A["url#35;40;x)"] --> B'],
  ["an entity that decodes to a backslash", 'flowchart TD\n  A["&#92;"] --> B'],
  ["an HTML entity without its semicolon", 'flowchart TD\n  A["url&#40x)"] --> B'],
  ["image-set()", `${FM}stateDiagram-v2\n  classDef c background-image:image-set("//attacker.invalid/x" 1x)`],
  ["-webkit-image-set()", `${FM}stateDiagram-v2\n  classDef c background-image:-webkit-image-set("//a.invalid/x" 1x)`],
  ["cross-fade()", `${FM}stateDiagram-v2\n  classDef c background-image:cross-fade("//a.invalid/x", red)`],
  ["image()", `${FM}stateDiagram-v2\n  classDef c background-image:image("//a.invalid/x")`],
  ["src()", `${FM}stateDiagram-v2\n  classDef c background-image:src("//a.invalid/x")`],
  ["an @import", `%%{init: {"themeCSS": "@import '${A}/x.css';"}}%%\npie title P\n  "a" : 1`],
  ["an @font-face", `%%{init: {"themeCSS": "@font-face { font-family: f }"}}%%\npie title P\n  "a" : 1`],
  ["a gantt todayMarker url()", `gantt\n  todayMarker filter:url(//attacker.invalid/x#f)`],
  ["a sequence actor icon", `sequenceDiagram\n  properties Alice: {"icon": "${A}/i.png"}\n  Alice->>Bob: hi`],
  ["sequence details", "sequenceDiagram\n  participant Alice\n  DETAILS Alice: root"],
  ["a statement after a semicolon", "sequenceDiagram\n  Alice->>Bob: hi; properties Alice: {}"],
  ["entities nested past the limit", "flowchart TD\n  A[x#35;35;35;35;40;]"],
])("refuses stock rendering for %s", (_name, code) => {
  expect(refusesStockRender(code)).toBe(true);
});

it.each([
  ["a plain flowchart", "flowchart TD\n  A-->B"],
  ["a gantt chart", "gantt\n  dateFormat YYYY-MM-DD\n  section S\n  t :a1, 2024-01-01, 3d"],
  ["a pie chart", 'pie title Pets\n  "Dogs" : 386\n  "Cats" : 85'],
  ["a mindmap", "mindmap\n  root((r))\n    a[child]"],
  ["a closing hex colour in a classDef", `${FM}flowchart TD\n  A --> B\n  classDef c fill:#f96;\n  class A c`],
  ["style colours", `${FM}flowchart TD\n  A --> B\n  style A fill:#f9f,stroke:#333,stroke-width:4px`],
  ["mermaid's quote and number entities", 'flowchart TD\n  A["#quot;hi#quot; #9829;"] --> B'],
  ["HTML's safe entities", `${FM}flowchart TD\n  A["a &amp; b &lt;c&gt;"] --> B`],
  ["the word image in a label", `${FM}flowchart TD\n  A["image (1) of the url"] --> B`],
  ["a shape without an image", `${FM}flowchart TD\n  A@{ shape: rounded, label: "x" }`],
  ["an icon shape", `${FM}flowchart TD\n  A@{ icon: "fa:user", label: "u" }`],
  ["the word properties in a label", "sequenceDiagram\n  Alice->>Bob: check the properties"],
])("allows stock rendering for %s", (_name, code) => {
  expect(refusesStockRender(code)).toBe(false);
});

it("strips beautiful-mermaid's font @import rules and keeps the rest", () => {
  const svg = "<svg><style>\n"
    + "  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500&amp;display=swap');\n"
    + "  @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&amp;display=swap');\n"
    + "  text { font-family: 'Inter', system-ui, sans-serif; }\n"
    + "</style><text>@import url(x) stays as label text</text></svg>";
  const stripped = stripCssImports(svg);
  expect(stripped).not.toContain("fonts.googleapis.com");
  expect(stripped).toContain("text { font-family: 'Inter', system-ui, sans-serif; }");
  expect(stripped).toContain("<text>@import url(x) stays as label text</text>");
});

it("strips a quoted-string @import with a media list", () => {
  expect(stripCssImports('<svg><style>@import "https://x.test/a.css" screen; a{}</style></svg>'))
    .toBe("<svg><style> a{}</style></svg>");
});

// The regexes asMermaidReadsEntities replaced, kept as the oracle. They
// backtrack cubically on a long line with no ";".
function oldReads(code: string): string {
  return code
    .replace(/style.*:\S*#.*;/g, (line) => line.slice(0, -1))
    .replace(/classDef.*:\S*#.*;/g, (line) => line.slice(0, -1));
}

it.each([
  "style A fill:#f96;",
  "style A fill:#f96",
  "style A fill:#f96;stroke:#333;",
  "style A fill:#f96; stroke:#333;;",
  "classDef c fill:#f96;",
  "classDef c fill:#f96",
  "classDef c a:#1;b:#2;",
  "style A #f96:fill;",
  "style A fill: #f96;",
  "style A fill:#f96 ;x",
  "style A fill:#;",
  "style A fill:;#",
  "x style A fill:#f96;",
  "x classDef c fill:#f96; y",
  "style A fill:#f96; classDef c fill:#333;",
  "classDef c fill:#333; style A fill:#f96;",
  "style style:#a;",
  "stylestyle:x y:#a;",
  "flowchart\n style A fill:#f96;\n classDef c fill:#333;\n B",
  "style A fill:#f96;\r\nclassDef c fill:#333;\r\n",
  "style A fill:#f96;\rclassDef c fill:#333;",
  "style A fill:#f96 ;\nstyle B a:#1;",
  "style A fill\n:#f96;",
  "",
])("drops the closing semicolon as the old regex did: %j", (code) => {
  expect(asMermaidReadsEntities(code)).toBe(oldReads(code));
});

it.each([
  ["style", "style" + ":#".repeat(50_000)],
  ["classDef", "classDef" + ":#".repeat(50_000)],
])("refuses a long %s line without a semicolon in linear time", (_name, code) => {
  const t0 = performance.now();
  refusesStockRender(code);
  expect(performance.now() - t0).toBeLessThan(100);
});
