// Asset file browser (/files): browse, copy-link, orphan purge, linked
// delete, and export (pkm-jdu3).
import { expect, test } from "./fixtures";
import { waitForServerText } from "./server-state";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8"
  + "z8DQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
// Different bytes -> different sha256 for the second asset.
const PNG2 = Buffer.concat([PNG, Buffer.from([0])]);

async function login(page) {
  await page.goto("/login");
  await page.fill("#pw", "e2e-pw");
  await page.click("text=log in");
  await page.waitForURL("**/");
  await expect(page.locator(".ws-banner")).toHaveCount(0);
}

async function upload(page, name: string, buffer: Buffer) {
  const r = await page.request.post("/api/assets", {
    multipart: { file: { name, mimeType: "image/png", buffer } },
  });
  expect(r.ok()).toBeTruthy();
  return r.json();
}

test("browse, orphan purge, linked delete, export", async ({ page }) => {
  await login(page);
  const title = `Files E2E ${Date.now()}`;
  const linked = await upload(page, "linked.png", PNG);
  const orphan = await upload(page, "orphan.png", PNG2);
  await page.request.post("/api/pages", { data: { title } });
  const uid = `filese2e${Date.now()}`;
  await page.request.post("/api/ops", {
    data: {
      client_id: "e2e", batch_id: `files-${uid}`,
      ops: [{ op: "create", uid, page_title: title, parent_uid: null,
              order_idx: 0, text: `diagram: ![](${linked.url})` }],
    },
  });

  await page.goto("/files");
  await expect(page.getByRole("heading", { name: "Files" }))
    .toBeVisible();
  await expect(page.getByText("linked.png")).toBeVisible();

  // Orphan copy-link (clipboard patched before click).
  await page.evaluate(() => {
    (navigator.clipboard as any).writeText = (t: string) => {
      (window as any).__copied = t;
      return Promise.resolve();
    };
  });
  const orphanCard = page.locator(".file-card",
                                  { hasText: "orphan.png" });
  await orphanCard.getByRole("button", { name: "Copy link" }).click();
  expect(await page.evaluate(() => (window as any).__copied))
    .toContain(`](${orphan.url})`);

  // Orphan purge: filter -> select all -> calm delete.
  // exact: true -- getByLabel's default substring match would otherwise
  // also hit the "Select linked.png" checkbox's aria-label.
  await page.getByLabel("Linked", { exact: true }).selectOption("orphan");
  await expect(page.getByText("linked.png")).toHaveCount(0);
  await page.getByRole("button", { name: "Select all" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(/None are linked/)).toBeVisible();
  await page.getByRole("button", { name: /^Delete files?$/ }).click();
  await expect(page.getByText(/^Deleted /)).toBeVisible();
  expect((await page.request.get(orphan.url)).status()).toBe(404);

  // Linked delete goes loud, lists the page, strips the token.
  await page.getByLabel("Linked", { exact: true }).selectOption("all");
  await page.getByLabel("Select linked.png").check();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText(/still linked/)).toBeVisible();
  await expect(page.getByText(new RegExp(title))).toBeVisible();
  await page.getByRole("button", { name: "Delete file" }).click();
  await expect(page.getByText(/^Deleted /)).toBeVisible();
  await waitForServerText(page, title, "diagram:");
  expect((await page.request.get(linked.url)).status()).toBe(404);
});

test("export selected downloads a zip", async ({ page }) => {
  await login(page);
  await upload(page, "export-me.png", Buffer.concat([PNG, PNG2]));
  await page.goto("/files");
  await page.getByLabel("Select export-me.png").check();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Export" }).click(),
  ]);
  expect(download.suggestedFilename())
    .toMatch(/^assets-\d{4}-\d{2}-\d{2}\.zip$/);
});
