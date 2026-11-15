// "Click to start writing…" on an empty Paper/ page seeds the Paper template
// from web/src/templates/Paper.md, with the caret at the end of Tags::.
import { expect, test } from "./ownPage";
import { waitForServerText } from "./server-state";

test("start-writing on a Paper/ page seeds its attribute blocks", async ({
  page, ownPage: _ownPage, scratch,
}) => {
  const title = await scratch.open("Paper/");
  await page.getByText("Click to start writing…").click();
  await page.keyboard.type(" #AI");
  // The first Escape closes the tag popup, the second stops editing.
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await waitForServerText(page, title, "Tags:: #Paper #AI");
  await waitForServerText(page, title, "Local copy:: ");

  await page.reload();
  await expect(page.locator(".attribute")).toHaveText(
    ["Tags", "URL", "Date", "Local copy"]);
});
