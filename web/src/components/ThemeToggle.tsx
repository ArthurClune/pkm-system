// pattern: Imperative Shell
import { useTheme } from "../useTheme";
import { AutoThemeIcon, MoonIcon, SunIcon } from "./icons";

const LABEL: Record<ReturnType<typeof useTheme>["preference"], string> = {
  system: "Auto",
  light: "Light",
  dark: "Dark",
};

const ICON: Record<ReturnType<typeof useTheme>["preference"], () => JSX.Element> = {
  system: AutoThemeIcon,
  light: SunIcon,
  dark: MoonIcon,
};

/** Cycles system -> light -> dark -> system on click. Lives in the left nav
 * next to Search. */
export function ThemeToggle() {
  const { preference, cycle } = useTheme();
  const PreferenceIcon = ICON[preference];
  return (
    <button
      type="button"
      className="nav-link theme-toggle"
      onClick={cycle}
      aria-label={`Theme: ${LABEL[preference]}. Click to change.`}
    >
      <PreferenceIcon /> {LABEL[preference]}
    </button>
  );
}
