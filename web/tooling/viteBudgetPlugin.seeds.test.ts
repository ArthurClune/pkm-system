import { describe, expect, it } from "vitest";
import {
  isBeautifulMermaidSeed,
  isHljsSeed,
  isKatexSeed,
  isMermaidSeed,
} from "./viteBudgetPlugin";

// Regression: the repo's worktrees live under directory names like
// .claude/worktrees/beautiful-mermaid/, so a seed regex that matches the
// package name anywhere in the path claims EVERY module in that checkout
// (2200 seeds observed) and the owned-bytes cap absorbs unrelated chunks.
// Seeds must anchor the package name to its node_modules/ segment.

const WT = "/repo/.claude/worktrees/beautiful-mermaid/web";

describe("owned-graph seed predicates", () => {
  it("match the package under plain and pnpm node_modules layouts", () => {
    expect(isMermaidSeed(`${WT}/node_modules/mermaid/dist/mermaid.core.mjs`)).toBe(true);
    expect(isMermaidSeed(
      `${WT}/node_modules/.pnpm/mermaid@11.16.0/node_modules/mermaid/dist/x.mjs`,
    )).toBe(true);
    expect(isBeautifulMermaidSeed(
      `${WT}/node_modules/.pnpm/beautiful-mermaid@1.1.3/node_modules/beautiful-mermaid/dist/index.js`,
    )).toBe(true);
    expect(isKatexSeed(
      `${WT}/node_modules/.pnpm/katex@0.17.0/node_modules/katex/dist/katex.mjs`,
    )).toBe(true);
    expect(isHljsSeed(
      `${WT}/node_modules/.pnpm/highlight.js@11.11.1/node_modules/highlight.js/lib/common.js`,
    )).toBe(true);
  });

  it("hljs seed does not treat the package name's dot as a wildcard", () => {
    // isHljsSeed is written with an escaped "\." rather than via
    // isPackageModule, which would leave the dot unescaped and match any
    // character -- e.g. "highlightXjs" must NOT be seeded.
    expect(isHljsSeed(`${WT}/node_modules/highlightXjs/lib/common.js`)).toBe(false);
  });

  it("seed the app-side beautifulMermaid.ts barrel so its chunk counts as wholly owned", () => {
    // Mirrors the PdfViewer.tsx precedent: the emitted chunk contains the
    // app-side re-export module alongside the library, and ownership is
    // all-or-nothing per chunk.
    expect(isBeautifulMermaidSeed(`${WT}/src/components/beautifulMermaid.ts`)).toBe(true);
  });

  it("ignore a checkout directory that happens to carry the package name", () => {
    expect(isBeautifulMermaidSeed(`${WT}/src/components/MermaidDiagram.tsx`)).toBe(false);
    expect(isBeautifulMermaidSeed(
      `${WT}/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js`,
    )).toBe(false);
    expect(isMermaidSeed(
      "/repo/.claude/worktrees/mermaid/web/node_modules/.pnpm/react@18.3.1/node_modules/react/index.js",
    )).toBe(false);
  });

  it("do not let beautiful-mermaid's package dir satisfy the mermaid seed", () => {
    expect(isMermaidSeed(
      `${WT}/node_modules/.pnpm/beautiful-mermaid@1.1.3/node_modules/beautiful-mermaid/dist/index.js`,
    )).toBe(false);
  });
});
