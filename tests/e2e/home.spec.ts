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
  await page.getByLabel(/I agree to the service terms/).check();
  await page
    .getByLabel(/I understand this is an automated CRO opinion/)
    .check();
  await page
    .getByRole("button", { name: "Roast my landing page — ₹199" })
    .click();
  await expect(
    page.getByText(
      "Secure checkout is temporarily unavailable. No payment was taken.",
    ),
  ).toBeVisible();
});

test("opens Razorpay and reports only server-verified authorization", async ({
  page,
}) => {
  const providerResponse = {
    razorpay_order_id: "order_browserTest123",
    razorpay_payment_id: "pay_browserTest456",
    razorpay_signature: "a".repeat(64),
  };
  let verificationBody: unknown;
  let checkoutScriptRequests = 0;
  await page.route("https://checkout.razorpay.com/v1/checkout.js", (route) => {
    checkoutScriptRequests += 1;
    return route.fulfill({
      contentType: "application/javascript",
      body: `window.Razorpay = class {
        constructor(options) { this.options = options; }
        on() {}
        open() { this.options.handler(${JSON.stringify(providerResponse)}); }
      };`,
    });
  });
  await page.route("**/api/checkout", (route) =>
    route.fulfill({
      status: 201,
      contentType: "application/json",
      body: JSON.stringify({
        orderId: providerResponse.razorpay_order_id,
        keyId: "rzp_test_browserSafe",
        amount: 19_900,
        currency: "INR",
        name: "RoastMyLP",
        description: "One screenshot-based landing page Roast",
      }),
    }),
  );
  await page.route("**/api/checkout/verify", async (route) => {
    verificationBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ status: "PAYMENT_AUTHORIZED" }),
    });
  });

  await page.goto("/");
  expect(checkoutScriptRequests).toBe(0);
  await page.getByLabel("Landing page URL").fill("https://example.com");
  await page
    .getByLabel("Email for your private report")
    .fill("buyer@example.com");
  await page.getByLabel(/I agree to the service terms/).check();
  await page
    .getByLabel(/I understand this is an automated CRO opinion/)
    .check();
  await page
    .getByRole("button", { name: "Roast my landing page — ₹199" })
    .click();

  await expect(
    page.getByText(
      "Payment authorization verified. We are confirming capture before starting your review.",
    ),
  ).toBeVisible();
  expect(checkoutScriptRequests).toBe(1);
  expect(verificationBody).toEqual(providerResponse);
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
