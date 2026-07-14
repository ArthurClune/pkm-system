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

describe("outline line spacing", () => {
  test("uses 1.4 line-height for block rows and numbered bullets", () => {
    expect(ruleFor(".block-row")).toContain("line-height: 1.4;");
    expect(ruleFor(".bullet.numbered")).toContain("line-height: 1.4;");
  });
});
