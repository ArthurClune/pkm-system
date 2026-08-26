import { describe, expect, it } from "vitest";
import { mermaidThemeVariables } from "./mermaidTheme";

// A lookup that returns a distinct recognisable value per token name, so
// each assertion proves which token feeds which mermaid variable.
const byName = (name: string) => `var(${name})-value`;

describe("mermaidThemeVariables", () => {
  it("maps app design tokens onto mermaid's base-theme variables", () => {
    const vars = mermaidThemeVariables(false, byName);
    expect(vars.background).toBe("var(--color-bg-surface)-value");
    expect(vars.primaryColor).toBe("var(--color-bg-subtle)-value");
    expect(vars.primaryTextColor).toBe("var(--color-text)-value");
    expect(vars.primaryBorderColor).toBe("var(--color-border-strong)-value");
    expect(vars.lineColor).toBe("var(--color-text-muted)-value");
    expect(vars.textColor).toBe("var(--color-text)-value");
    expect(vars.clusterBkg).toBe("var(--color-bg-sidebar)-value");
    expect(vars.clusterBorder).toBe("var(--color-border-subtle)-value");
    expect(vars.edgeLabelBackground).toBe("var(--color-bg)-value");
  });

  it("carries the dark flag through as mermaid's darkMode", () => {
    expect(mermaidThemeVariables(true, byName).darkMode).toBe(true);
    expect(mermaidThemeVariables(false, byName).darkMode).toBe(false);
  });

  it("always sets the app font stack, independent of token lookup", () => {
    const vars = mermaidThemeVariables(false, () => "");
    expect(vars.fontFamily).toContain("-apple-system");
    expect(vars.fontSize).toBe("14px");
  });

  it("omits variables whose token resolves empty so mermaid derives its own", () => {
    // jsdom (and any context where styles.css isn't loaded) resolves custom
    // properties to "" -- an empty-string color would break mermaid's own
    // derivation, so the entry must be absent, not empty.
    const vars = mermaidThemeVariables(false, () => "");
    expect("lineColor" in vars).toBe(false);
    expect("primaryColor" in vars).toBe(false);
  });

  it("trims whitespace getComputedStyle leaves on custom property values", () => {
    const vars = mermaidThemeVariables(false, () => "  #3f4758 ");
    expect(vars.lineColor).toBe("#3f4758");
  });
});
