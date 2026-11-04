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
  const timeline = page.getByRole("list", {
    name: "Status updates, newest first",
  });
  await expect(
    timeline.getByText(
      "Your request is queued. It will start when a session slot is available.",
      { exact: true },
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "All requests" }).click();
  await expect(
    page.getByRole("columnheader", { name: "Total time" }),
  ).toBeVisible();
  const activeRow = page.getByRole("row").filter({
    has: page.getByRole("button", { name: instruction, exact: true }),
  });
  const activeTime = activeRow.locator(".duration");
  const initialTime = await activeTime.innerText();
  await expect(activeTime).not.toHaveText(initialTime);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: instruction, exact: true }).click();
  await expect(
    timeline.getByText("Pi is working on this request in its own session.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Result", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  const savedHistory = await timeline.locator("li").allTextContents();
  expect(savedHistory[0]).toContain("Result files saved and ready.");
  expect(savedHistory.at(-1)).toContain("Request submitted.");
  for (const value of await timeline.locator("time").allTextContents())
    expect(value).toMatch(/\d{1,2}:\d{2}:\d{2}/);
  const timestamps = await timeline
    .locator("time")
    .evaluateAll((nodes) =>
      nodes.map((node) => Date.parse(node.getAttribute("datetime")!)),
    );
  expect(timestamps).toEqual([...timestamps].sort((a, b) => b - a));
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
    page.getByRole("columnheader", { name: "Total time" }),
  ).toBeVisible();
  const finishedTime = page
    .getByRole("row")
    .filter({
      has: page.getByRole("button", { name: instruction, exact: true }),
    })
    .locator(".duration");
  const duration = await finishedTime.innerText();
  expect(duration).toMatch(/^\d+m \d{2}s$/);
  await page.waitForTimeout(1200);
  await expect(finishedTime).toHaveText(duration);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `/tmp/workflow-application-list-${info.project.name}.png`,
    fullPage: true,
  });
  await expect(
    page.getByRole("button", { name: instruction, exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: instruction, exact: true }).click();
  await expect(
    page.getByText("Your result is ready.", { exact: true }),
  ).toBeVisible();
  await expect(timeline.locator("li")).toHaveText(savedHistory);
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
