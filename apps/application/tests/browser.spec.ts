import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("submit attached input, find persistent request, and retrieve verified output", async ({
  page,
}, info) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.goto("/");
  await expect(page).toHaveTitle("Workflow requests");
  await expect(
    page.getByRole("heading", { name: "New request" }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Default system prompt", { exact: true }),
  ).toBeHidden();
  await page
    .getByRole("button", { name: "System prompt", exact: true })
    .click();
  const prompt = `Complete this independent request in its assigned folder. Browser prompt ${info.project.name} ${Date.now()}`;
  await page.getByLabel("Default system prompt", { exact: true }).fill(prompt);
  const save = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/settings") &&
      response.request().method() === "PUT",
  );
  await page.getByLabel("Instructions", { exact: true }).focus();
  expect((await save).status()).toBe(200);
  await page.reload();
  await expect(
    page.getByLabel("Default system prompt", { exact: true }),
  ).toBeHidden();
  await page
    .getByRole("button", { name: "System prompt", exact: true })
    .click();
  await expect(
    page.getByLabel("Default system prompt", { exact: true }),
  ).toHaveValue(prompt);
  await page
    .getByRole("button", { name: "System prompt", exact: true })
    .click();
  const instruction = `Browser request ${info.project.name} ${Date.now()}`;
  await page.getByLabel("Instructions", { exact: true }).fill(instruction);
  await page.getByLabel("Input files").setInputFiles({
    name: "evidence.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Permitted test input."),
  });
  await page.getByRole("button", { name: "Submit request" }).click();
  await expect(page.getByRole("status").first()).toContainText(
    "Request submitted",
  );
  await expect(
    page.getByRole("heading", { name: "Result", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText("Your result is ready.", { exact: true }),
  ).toBeVisible();
  await page
    .getByText("System prompt used for this request", { exact: true })
    .click();
  await expect(page.getByText(prompt, { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("link", { name: "result.txt", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe("result.txt");
  const file = await download.path();
  expect(file).not.toBeNull();
  if (file)
    expect((await readFile(file)).toString()).toBe(
      "Browser verified downloadable result.",
    );
  await page.getByRole("button", { name: "All requests" }).click();
  await page.reload();
  await expect(
    page.getByRole("button", { name: instruction, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: instruction, exact: true }).click();
  await expect(
    page.getByText("Your result is ready.", { exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `/tmp/workflow-application-${info.project.name}.png`,
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
