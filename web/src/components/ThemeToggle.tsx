// pattern: Imperative Shell
import { useTheme } from "../useTheme";

const LABEL: Record<ReturnType<typeof useTheme>["preference"], string> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

const ICON: Record<ReturnType<typeof useTheme>["preference"], string> = {
  system: "🌓",
  light: "☀️",
  dark: "🌙",
};

/** Cycles system -> light -> dark -> system on click. Lives in the left nav
 * next to Search. */
export function ThemeToggle() {
  const { preference, cycle } = useTheme();
  return (
    <button
      type="button"
      className="nav-link theme-toggle"
      onClick={cycle}
      aria-label={`Theme: ${LABEL[preference]}. Click to change.`}
    >
      <span aria-hidden="true">{ICON[preference]}</span> {LABEL[preference]}
    </button>
  );
}
