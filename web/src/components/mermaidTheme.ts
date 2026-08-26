// pattern: Functional Core
// Maps the app's CSS design tokens (styles.css) onto mermaid's base-theme
// variables, so diagrams share the app's palette and font instead of
// mermaid's stock look. Pure: the token lookup is injected -- the shell
// (MermaidDiagram.tsx) feeds it getComputedStyle, tests feed it a fake.

/** The app font stack from styles.css's body rule, restated here because a
 * CSS custom property doesn't exist for it and mermaid needs it as a value. */
const APP_FONT_STACK =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/** Which design token feeds which mermaid base-theme variable. */
const TOKEN_VARIABLES: Record<string, string> = {
  background: "--color-bg-surface",
  primaryColor: "--color-bg-subtle",
  primaryTextColor: "--color-text",
  primaryBorderColor: "--color-border-strong",
  lineColor: "--color-text-muted",
  textColor: "--color-text",
  clusterBkg: "--color-bg-sidebar",
  clusterBorder: "--color-border-subtle",
  edgeLabelBackground: "--color-bg",
};

/**
 * themeVariables for mermaid.initialize({ theme: "base", ... }).
 *
 * A token that resolves empty (styles.css not loaded, e.g. jsdom) is
 * omitted rather than passed as "" -- mermaid derives sensible values for
 * absent variables but chokes on empty-string colors.
 */
export function mermaidThemeVariables(
  dark: boolean,
  token: (name: string) => string,
): Record<string, unknown> {
  const vars: Record<string, unknown> = {
    darkMode: dark,
    fontFamily: APP_FONT_STACK,
    fontSize: "14px",
  };
  for (const [variable, tokenName] of Object.entries(TOKEN_VARIABLES)) {
    const value = token(tokenName).trim();
    if (value) vars[variable] = value;
  }
  return vars;
}

/** Which design token feeds which beautiful-mermaid RenderOptions slot.
 * No dark flag: light vs dark is carried entirely by the resolved token
 * values, so callers just re-resolve when the effective theme changes. */
const BM_OPTION_TOKENS: Record<string, string> = {
  bg: "--color-bg-surface",
  fg: "--color-text",
  line: "--color-text-muted",
  muted: "--color-text-muted",
  surface: "--color-bg-subtle",
  border: "--color-border-strong",
  accent: "--color-accent",
};

/** RenderOptions for beautiful-mermaid's renderMermaid(). Same empty-token
 * rule as mermaidThemeVariables: absent beats "" (the library falls back to
 * its own bg/fg defaults and two-color derivation). */
export function beautifulMermaidOptions(
  token: (name: string) => string,
): Record<string, string | boolean> {
  // transparent: stock mermaid SVGs paint no background; an opaque --bg card
  // would seam against block-row hover/focus tints, so let the page show
  // through here too.
  const opts: Record<string, string | boolean> = {
    font: APP_FONT_STACK,
    transparent: true,
  };
  for (const [option, tokenName] of Object.entries(BM_OPTION_TOKENS)) {
    const value = token(tokenName).trim();
    if (value) opts[option] = value;
  }
  return opts;
}
