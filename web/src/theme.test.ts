import { describe, expect, it } from "vitest";
import {
  isThemePreference,
  nextThemePreference,
  resolveEffectiveTheme,
} from "./theme";

describe("isThemePreference", () => {
  it("accepts the three valid preferences", () => {
    expect(isThemePreference("system")).toBe(true);
    expect(isThemePreference("light")).toBe(true);
    expect(isThemePreference("dark")).toBe(true);
  });

  it("rejects anything else, including null/undefined", () => {
    expect(isThemePreference("auto")).toBe(false);
    expect(isThemePreference("")).toBe(false);
    expect(isThemePreference(null)).toBe(false);
    expect(isThemePreference(undefined)).toBe(false);
  });
});

describe("nextThemePreference", () => {
  it("cycles system -> light -> dark -> system", () => {
    expect(nextThemePreference("system")).toBe("light");
    expect(nextThemePreference("light")).toBe("dark");
    expect(nextThemePreference("dark")).toBe("system");
  });
});

describe("resolveEffectiveTheme", () => {
  it("follows the system flag when preference is 'system'", () => {
    expect(resolveEffectiveTheme("system", true)).toBe("dark");
    expect(resolveEffectiveTheme("system", false)).toBe("light");
  });

  it("ignores the system flag when preference is explicit", () => {
    expect(resolveEffectiveTheme("light", true)).toBe("light");
    expect(resolveEffectiveTheme("dark", false)).toBe("dark");
  });
});
