// Drift guard: every slash command offered by the menu must be documented
// on the help page (docs/keyboard.md), so adding a command without updating
// the doc fails here.
import { describe, expect, test } from "vitest";
import keyboardDoc from "../../../docs/keyboard.md?raw";
import { SLASH_COMMANDS } from "../outline/slashCommands";

describe("help page documents every slash command", () => {
  test("has a Slash commands section", () => {
    expect(keyboardDoc).toContain("## Slash commands");
  });

  for (const command of SLASH_COMMANDS) {
    test(`documents /${command.name}`, () => {
      expect(keyboardDoc).toContain("`/" + command.name + "`");
    });
  }
});
