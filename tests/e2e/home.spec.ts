import { expect, test } from "@playwright/test";

test("presents the paid Roast clearly without fabricated proof", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle(/RoastMyLP/);
  await expect(
    page.getByRole("heading", { name: "Find what's costing you conversions." }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Roast my landing page — ₹199" }),
  ).toBeVisible();
  await expect(page.getByLabel("Landing page URL")).toBeVisible();
  await expect(page.getByLabel("Email for your private report")).toBeVisible();
  await expect(
    page.getByRole("link", { name: "service terms" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "privacy" }).first(),
  ).toBeVisible();
  await expect(
    page.getByText(
      /customer audits or use them as examples without recorded permission/i,
    ),
  ).toBeVisible();
});

test("identifies errors in text and focuses the first invalid field", async ({
  page,
}) => {
  await page.goto("/");
  await page
    .getByRole("button", { name: "Roast my landing page — ₹199" })
    .click();
  const url = page.getByLabel("Landing page URL");
  await expect(url).toBeFocused();
  await expect(url).toHaveAttribute("aria-invalid", "true");
  await expect(
    page.getByText("Enter the landing page URL you want roasted."),
  ).toBeVisible();
  await expect(
    page.getByText("Enter the email where we should send the report."),
  ).toBeVisible();
});

test("does not fake checkout when valid details are entered", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByLabel("Landing page URL").fill("https://example.com");
  await page
    .getByLabel("Email for your private report")
    .fill("buyer@example.com");
  await page
    .getByRole("button", { name: "Roast my landing page — ₹199" })
    .click();
  await expect(
    page.getByText(
      "Checkout isn’t live yet. Nothing was saved and no payment was taken.",
    ),
  ).toBeVisible();
});

test("has no horizontal overflow at 320 CSS pixels", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 800 });
  await page.goto("/");
  const dimensions = await page.evaluate(() => ({
    viewport: window.innerWidth,
    content: document.documentElement.scrollWidth,
  }));
  expect(dimensions.content).toBeLessThanOrEqual(dimensions.viewport);
});
