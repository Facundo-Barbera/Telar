import { describe, expect, test } from "bun:test";
import { distillSpec, playwrightConfigTemplate, type DistillFeature } from "../src/distill";
import type { CriterionResult, VerifierReport } from "../src/schemas";

const BANNED = /(\.locator\(|\.nth\(|page\.\$|css=|xpath=)/;

function report(criteria: CriterionResult[], url = "https://app.example.com/dashboard"): VerifierReport {
  return { feature: "Dashboard", url, ok: true, summary: "ok", criteria, sessionEvidence: [] };
}

function criterion(over: Partial<CriterionResult>): CriterionResult {
  return {
    criterion: "does the thing",
    verdict: "pass",
    observed: "it did the thing",
    evidence: [],
    repro: [],
    locators: [],
    ...over,
  };
}

const feature: DistillFeature = { name: "Dashboard" };

describe("distillSpec — repro-driven", () => {
  const c = criterion({
    criterion: "navigating to projects shows the submit button",
    repro: [
      { action: "navigate", target: "projects page", value: "https://app.example.com/projects" },
      { action: "click", target: "button 'Submit'" },
      { action: "assert", target: "button 'Submit'" },
    ],
  });
  const out = distillSpec(feature, report([c]));

  test("emits a relative goto", () => {
    expect(out).toContain("await page.goto('/projects');");
  });

  test("emits a click on a getByRole locator", () => {
    expect(out).toContain("await page.getByRole('button', { name: 'Submit' }).click();");
  });

  test("emits a web-first visibility assertion", () => {
    expect(out).toContain("await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible();");
  });

  test("begins with the playwright import and describe block", () => {
    expect(out.startsWith("import { test, expect } from '@playwright/test';")).toBe(true);
    expect(out).toContain("test.describe('Dashboard', () => {");
  });

  test("no banned patterns", () => {
    expect(BANNED.test(out)).toBe(false);
  });
});

describe("distillSpec — locator-only pass criterion", () => {
  const c = criterion({
    criterion: "shows the header and nav",
    locators: ["getByRole('heading', { name: 'Welcome' })", "page.getByRole('navigation')"],
  });
  const out = distillSpec(feature, report([c]));

  test("emits the base goto", () => {
    expect(out).toContain("await page.goto('/dashboard');");
  });

  test("emits a visibility assertion per locator", () => {
    expect(out).toContain("await expect(page.getByRole('heading', { name: 'Welcome' })).toBeVisible();");
    expect(out).toContain("await expect(page.getByRole('navigation')).toBeVisible();");
  });
});

describe("distillSpec — string safety", () => {
  test("apostrophes in criterion text are escaped into a valid literal", () => {
    const c = criterion({
      criterion: "shows the 'Save' button",
      locators: ["getByRole('button', { name: 'Save' })"],
    });
    const out = distillSpec(feature, report([c]));
    expect(out).toContain("test('shows the \\'Save\\' button'");
    // The emitted title literal must be evaluable as a real single-quoted JS
    // string — i.e. every embedded apostrophe is backslash-escaped.
    const titleLine = out.split("\n").find((l) => l.trimStart().startsWith("test('shows the"));
    expect(titleLine).toBeDefined();
    const literal = titleLine!.match(/test\((.*'), \{/)![1];
    expect(eval(literal)).toBe("shows the 'Save' button");
  });
});

describe("distillSpec — safety: unsafe locators are always discarded", () => {
  test("an unsafe raw selector entry never appears in output", () => {
    const c = criterion({
      criterion: "shows a widget",
      locators: [".some-class", "getByRole('button', { name: 'OK' })"],
    });
    const out = distillSpec(feature, report([c]));
    expect(BANNED.test(out)).toBe(false);
    expect(out).not.toContain(".some-class");
    expect(out).toContain("await expect(page.getByRole('button', { name: 'OK' })).toBeVisible();");
  });

  test("an unsafe stored step.locator falls back to target-derived locator", () => {
    const c = criterion({
      criterion: "clicks submit",
      repro: [{ action: "click", target: "button 'Submit'", locator: ".btn-primary" }],
    });
    const out = distillSpec(feature, report([c]));
    expect(BANNED.test(out)).toBe(false);
    expect(out).not.toContain(".btn-primary");
    expect(out).toContain("await page.getByRole('button', { name: 'Submit' }).click();");
  });

  test("banned patterns never appear across a variety of unsafe inputs", () => {
    const c = criterion({
      criterion: "kitchen sink",
      locators: [".foo", "xpath=//div", "css=.x", "page.locator('.y')", "page.$('.z')"],
    });
    const out = distillSpec(feature, report([c]));
    expect(BANNED.test(out)).toBe(false);
  });

  test("a safe getBy* call with a chained brittle suffix is discarded, not emitted verbatim", () => {
    const c = criterion({
      criterion: "shows a widget",
      locators: ["getByRole(\"button\", { name: \"X\" }).locator(\".foo\")"],
    });
    const out = distillSpec(feature, report([c]));
    expect(BANNED.test(out)).toBe(false);
    expect(out).not.toContain(".locator(");
  });

  test("a stored locator with an unescaped apostrophe in its own argument is discarded, not spliced verbatim", () => {
    const c = criterion({
      criterion: "shows the profile link",
      // realistic browser_generate_locator-style output over real UI text
      // containing an apostrophe that was never escaped for a JS literal.
      locators: ["getByRole('link', { name: 'OBrien's page' })"],
    });
    const out = distillSpec(feature, report([c]));
    expect(out).not.toContain("OBrien's page");
    // the whole file must remain valid, evaluable JS (no unbalanced quote)
    expect(() => new Function(out.replace("import { test, expect } from '@playwright/test';", ""))).not.toThrow();
  });

  test("an unsafe stored step.locator with an unescaped apostrophe falls back to target-derived locator", () => {
    const c = criterion({
      criterion: "clicks submit",
      repro: [
        {
          action: "click",
          target: "button 'Submit'",
          // the stored locator's own name argument has an unescaped
          // apostrophe (as browser_generate_locator could produce over
          // real UI copy) — this must never be spliced in verbatim.
          locator: "getByRole('button', { name: 'Bob's Submit' })",
        },
      ],
    });
    const out = distillSpec(feature, report([c]));
    expect(out).not.toContain("Bob's Submit");
    expect(out).toContain("await page.getByRole('button', { name: 'Submit' }).click();");
  });

  test("a safe stored step.locator with a chained brittle suffix falls back to target-derived locator", () => {
    const c = criterion({
      criterion: "clicks submit",
      repro: [
        {
          action: "click",
          target: "button 'Submit'",
          locator: "getByRole('button', { name: 'Submit' }).nth(0)",
        },
      ],
    });
    const out = distillSpec(feature, report([c]));
    expect(BANNED.test(out)).toBe(false);
    expect(out).not.toContain(".nth(");
    expect(out).toContain("await page.getByRole('button', { name: 'Submit' }).click();");
  });
});

describe("distillSpec — degenerate criterion", () => {
  test("no repro and no locators -> test.skip", () => {
    const c = criterion({ criterion: "unverifiable claim" });
    const out = distillSpec(feature, report([c]));
    expect(out).toContain("test.skip('unverifiable claim'");
    expect(out).toContain("// no steps or role-locators recorded — re-derive via exploration");
  });
});

describe("distillSpec — non-pass criteria are excluded", () => {
  test("fail and flaky criteria produce no test block", () => {
    const c1 = criterion({ criterion: "failed thing", verdict: "fail" });
    const c2 = criterion({ criterion: "flaky thing", verdict: "flaky" });
    const out = distillSpec(feature, report([c1, c2]));
    expect(out).not.toContain("failed thing");
    expect(out).not.toContain("flaky thing");
  });
});

describe("distillSpec — url fallback", () => {
  test("an invalid absolute url falls back to '/'", () => {
    const c = criterion({ criterion: "loads", locators: ["getByRole('heading', { name: 'Hi' })"] });
    const out = distillSpec(feature, report([c], "not-a-url"));
    expect(out).toContain("await page.goto('/');");
  });
});

describe("distillSpec — CR escaping (raw \\r never reaches output)", () => {
  test("a repro fill step with a CRLF value is normalized, no raw CR in output", () => {
    const c = criterion({
      criterion: "fills the notes field",
      repro: [{ action: "fill", target: "textbox 'Notes'", value: "line one\r\nline two" }],
    });
    const out = distillSpec(feature, report([c]));
    expect(out).not.toContain("\r");
    expect(out).toContain("line one line two");
  });

  test("a criterion title containing a lone CR is normalized, no raw CR in output", () => {
    const c = criterion({
      criterion: "shows the\rbanner",
      locators: ["getByRole('banner')"],
    });
    const out = distillSpec(feature, report([c]));
    expect(out).not.toContain("\r");
  });

  test("a stored getBy* locator with a raw CR in its own argument is discarded, not spliced verbatim", () => {
    const c = criterion({
      criterion: "shows the profile link",
      locators: ["getByRole('link', { name: 'Bob\r Page' })"],
    });
    const out = distillSpec(feature, report([c]));
    expect(out).not.toContain("\r");
  });

  test("emitted spec is syntactically valid JS (parse check)", () => {
    const c1 = criterion({
      criterion: "fills the notes field",
      repro: [{ action: "fill", target: "textbox 'Notes'", value: "line one\r\nline two" }],
    });
    const c2 = criterion({
      criterion: "shows the\rbanner",
      locators: ["getByRole('banner')"],
    });
    const c3 = criterion({
      criterion: "shows the profile link",
      locators: ["getByRole('link', { name: 'Bob\r Page' })"],
    });
    const out = distillSpec(feature, report([c1, c2, c3]));
    const rest = out.split("\n").slice(1).join("\n");
    expect(() => new Function(rest)).not.toThrow();
  });
});

describe("playwrightConfigTemplate", () => {
  test("contains the baseline config fields", () => {
    const out = playwrightConfigTemplate();
    expect(out).toContain("retries: 2");
    expect(out).toContain("fullyParallel: true");
    expect(out).toContain("baseURL");
    expect(out).toContain("import { defineConfig, devices } from '@playwright/test';");
  });

  test("without storageStateSetup, no setup project", () => {
    const out = playwrightConfigTemplate();
    expect(out).not.toContain("name: 'setup'");
  });

  test("with storageStateSetup: true, includes a setup project", () => {
    const out = playwrightConfigTemplate({ storageStateSetup: true });
    expect(out).toContain("name: 'setup'");
    expect(out).toContain("storageState: '.telar/storageState.json'");
    expect(out).toContain("dependencies: ['setup']");
  });
});
