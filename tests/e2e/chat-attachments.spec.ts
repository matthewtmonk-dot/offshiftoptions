import { expect, test, type Page } from "@playwright/test";

const PNG_BUFFER = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=",
  "base64",
);

async function loginAsMatt(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill("matt@lst.local");
  await page.getByLabel("Password").fill(process.env.DEV_SEED_PASSWORD ?? "lstbuddy-dev-only");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: /Hey Matt/ })).toBeVisible();
}

async function dispatchImageEvent(page: Page, eventName: "drop" | "paste", fileName: string) {
  await page.getByTestId("chat-composer").evaluate(
    (node, payload) => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(new File([new Uint8Array(payload.bytes)], payload.fileName, { type: "image/png" }));
      const event = new Event(payload.eventName, { bubbles: true, cancelable: true });
      Object.defineProperty(event, payload.eventName === "paste" ? "clipboardData" : "dataTransfer", {
        value: dataTransfer,
      });
      node.dispatchEvent(event);
    },
    { bytes: [...PNG_BUFFER], eventName, fileName },
  );
}

test("Buddy Chat image attachments support picker, drag/drop, paste, remove, send, and preview", async ({ page }) => {
  test.setTimeout(60_000);
  const textMessage = `E2E image message ${Date.now()}`;

  await loginAsMatt(page);
  await page.goto("/chat");
  const composer = page.getByTestId("chat-composer");
  await expect(composer).toBeVisible();

  await composer.locator('input[type="file"]').setInputFiles({
    name: "button-upload.png",
    mimeType: "image/png",
    buffer: PNG_BUFFER,
  });
  await expect(composer.getByText("button-upload.png")).toBeVisible();
  await composer.getByRole("button", { name: "Remove button-upload.png" }).click();
  await expect(composer.getByText("button-upload.png")).toHaveCount(0);

  await dispatchImageEvent(page, "paste", "pasted-screenshot.png");
  await expect(composer.getByText("pasted-screenshot.png")).toBeVisible();
  await composer.getByRole("button", { name: "Remove pasted-screenshot.png" }).click();

  await dispatchImageEvent(page, "drop", "dropped-chart.png");
  await expect(composer.getByText("dropped-chart.png")).toBeVisible();
  await composer.locator('textarea[name="body"]').fill(textMessage);
  await composer.getByRole("button", { name: "Send" }).click();

  await expect(page.getByText(textMessage)).toBeVisible();
  await expect(page.getByRole("button", { name: "Open dropped-chart.png" }).last()).toBeVisible();
  await page.getByRole("button", { name: "Open dropped-chart.png" }).last().click();
  await expect(page.getByRole("dialog", { name: "dropped-chart.png" })).toBeVisible();
  await page.getByRole("button", { name: "Close image preview" }).click();
  await expect(page.getByRole("dialog", { name: "dropped-chart.png" })).toHaveCount(0);

  await composer.locator('input[type="file"]').setInputFiles({
    name: "image-only.png",
    mimeType: "image/png",
    buffer: PNG_BUFFER,
  });
  await composer.getByRole("button", { name: "Send" }).click();
  await expect(page.getByRole("button", { name: "Open image-only.png" }).last()).toBeVisible();
});
