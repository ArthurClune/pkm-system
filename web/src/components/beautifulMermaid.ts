// Re-export barrel, no runtime behaviour of its own (FCIS-exempt).
// Exists for two reasons: dynamic-importing this module names the lazy
// chunk beautifulMermaid-*.js (importing the package directly names it
// index-*.js after the package's dist/index.js, indistinguishable from the
// app entry in dist listings and served-bundle greps), and it gives tests a
// local seam to vi.mock without stubbing node_modules.
export { renderMermaid } from "beautiful-mermaid";
