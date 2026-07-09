import { describe, expect, test } from "bun:test";
import { lintSpec } from "../src/spec-lint";

describe("lintSpec — clean spec", () => {
  test("getByRole/getByLabel + toBeVisible produces no violations", () => {
    const src = `import { test, expect } from '@playwright/test';
test('shows submit', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();
  await page.getByLabel('Email').fill('a@b.com');
});
`;
    expect(lintSpec(src)).toEqual([]);
  });
});

describe("lintSpec — banned patterns", () => {
  test("page.locator(...) -> exactly one no-locator at the right line", () => {
    const src = `test('x', async ({ page }) => {\n  await page.locator('.foo').click();\n});\n`;
    const violations = lintSpec(src);
    expect(violations).toEqual([{ line: 2, rule: "no-locator", text: "await page.locator('.foo').click();" }]);
  });

  test(".nth(0) -> no-nth", () => {
    const violations = lintSpec("await page.getByRole('button').nth(0).click();");
    expect(violations).toContainEqual(
      expect.objectContaining({ rule: "no-nth", line: 1 }),
    );
  });

  test("xpath= -> no-xpath", () => {
    const violations = lintSpec("await page.locator('xpath=//div').click();");
    const rules = violations.map((v) => v.rule);
    expect(rules).toContain("no-xpath");
    expect(rules).toContain("no-locator");
  });

  test("css= -> no-css-engine", () => {
    const violations = lintSpec("await page.locator('css=.x').click();");
    expect(violations.map((v) => v.rule)).toContain("no-css-engine");
  });

  test("page.$('x') -> no-query-selector", () => {
    const violations = lintSpec("const el = page.$('x');");
    expect(violations).toEqual([{ line: 1, rule: "no-query-selector", text: "const el = page.$('x');" }]);
  });

  test("page.$$('x') -> no-query-selector", () => {
    const violations = lintSpec("const els = page.$$('x');");
    expect(violations).toEqual([{ line: 1, rule: "no-query-selector", text: "const els = page.$$('x');" }]);
  });

  test("page.$eval(...) -> no-query-selector", () => {
    const violations = lintSpec("const t = page.$eval('.foo', el => el.textContent);");
    expect(violations).toContainEqual(expect.objectContaining({ rule: "no-query-selector", line: 1 }));
  });

  test("page.$$eval(...) -> no-query-selector", () => {
    const violations = lintSpec("const t = page.$$eval('.foo', els => els.length);");
    expect(violations).toContainEqual(expect.objectContaining({ rule: "no-query-selector", line: 1 }));
  });

  test("page.waitForTimeout(500) -> no-wait-timeout", () => {
    const violations = lintSpec("await page.waitForTimeout(500);");
    expect(violations).toEqual([{ line: 1, rule: "no-wait-timeout", text: "await page.waitForTimeout(500);" }]);
  });
});

describe("lintSpec — setTimeout", () => {
  test("bare setTimeout(fn, 0) is flagged no-set-timeout", () => {
    const violations = lintSpec("setTimeout(fn, 0);");
    expect(violations).toEqual([{ line: 1, rule: "no-set-timeout", text: "setTimeout(fn, 0);" }]);
  });

  test("clearTimeout(t) is NOT flagged", () => {
    expect(lintSpec("clearTimeout(t);")).toEqual([]);
  });

  test("page.setDefaultTimeout(1) is NOT flagged", () => {
    expect(lintSpec("page.setDefaultTimeout(1);")).toEqual([]);
  });
});

describe("lintSpec — test title text is not code", () => {
  test("banned substring inside a test() title string is not flagged", () => {
    const src = "test('the page.locator(\\'.foo\\') api still renders the button', async ({ page }) => {\n" +
      "  await expect(page.getByRole('button', { name: 'X' })).toBeVisible();\n" +
      "});\n";
    expect(lintSpec(src)).toEqual([]);
  });

  test("a real .locator( call in the test body (not the title) is still flagged", () => {
    const src = "test('shows totals', async ({ page }) => {\n  await page.locator('.foo').click();\n});\n";
    expect(lintSpec(src)).toEqual([
      { line: 2, rule: "no-locator", text: "await page.locator('.foo').click();" },
    ]);
  });

  test("banned substring inside a test.describe() title string is not flagged", () => {
    const src = "test.describe('the page.locator(\\'.foo\\') feature', () => {\n});\n";
    expect(lintSpec(src)).toEqual([]);
  });
});

describe("lintSpec — line numbers across a multi-line source", () => {
  test("accurate 1-based line numbers, ordered by line then rule", () => {
    const src = [
      "import { test, expect } from '@playwright/test';", // 1
      "test('multi', async ({ page }) => {", // 2
      "  await page.goto('/');", // 3
      "  await page.locator('.a').nth(1).click();", // 4 -> no-locator, no-nth
      "  await page.waitForTimeout(100);", // 5 -> no-wait-timeout
      "  setTimeout(() => {}, 0);", // 6 -> no-set-timeout
      "});", // 7
    ].join("\n");
    const violations = lintSpec(src);
    expect(violations).toEqual([
      { line: 4, rule: "no-locator", text: "await page.locator('.a').nth(1).click();" },
      { line: 4, rule: "no-nth", text: "await page.locator('.a').nth(1).click();" },
      { line: 5, rule: "no-wait-timeout", text: "await page.waitForTimeout(100);" },
      { line: 6, rule: "no-set-timeout", text: "setTimeout(() => {}, 0);" },
    ]);
  });
});
