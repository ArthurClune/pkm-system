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
