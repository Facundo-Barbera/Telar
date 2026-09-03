/**
 * The credential-fill orchestrator, driven with fakes on every seam.
 *
 * THE LOAD-BEARING SUITE IS THE REDACTION ONE at the bottom: a sentinel
 * secret goes in through the fake vault and the tests assert it comes out in
 * exactly ONE place — the `browser_fill_form` arguments — and nowhere else:
 * not the request detail shown to a human, not the tool result handed back
 * to the model, not the process's own stdout/stderr.
 */
import { expect, test } from "bun:test";
import type { SecretAccessDetail } from "@telar/engine-client";
import { runSecretFill, scrubSecrets, type SecretAskOutcome, type SecretFillDeps } from "../src/browser/secret-fill";
import type { SecretsProvider } from "../src/secrets/onepassword";
import { textOf } from "../src/browser/helpers";

const SENTINEL = "SENTINEL-s3cr3t-a1b2c3";
const USERNAME = "facundo";

const TABS_GITHUB = "0: (current) [Sign in](https://github.com/login)";
const TABS_EVIL = "0: (current) [Sign in](https://evil.example/login)";

type Call = { name: string; args: Record<string, unknown> };

function fakeSecrets(overrides: Partial<SecretsProvider> = {}): SecretsProvider {
  return {
    listLoginCandidates: async () => ({
      ok: true,
      candidates: [
        { id: "item_gh", title: "GitHub", vault: "Personal", domain: "github.com" },
        { id: "item_work", title: "GitHub (work)", domain: "github.com" },
      ],
    }),
    readItemFields: async (_id, wants) => ({
      ok: true,
      values: wants.map((want) => ({ want, value: want.kind === "username" ? USERNAME : SENTINEL })),
    }),
    ...overrides,
  };
}

function fakeDeps(options: {
  tabs?: string[] | undefined;
  secrets?: SecretsProvider;
  outcome?: SecretAskOutcome;
  onAsk?: (detail: SecretAccessDetail) => void;
  fillError?: string;
} = {}): { deps: SecretFillDeps; calls: Call[]; asked: SecretAccessDetail[] } {
  const calls: Call[] = [];
  const asked: SecretAccessDetail[] = [];
  const tabs = options.tabs ?? [TABS_GITHUB, TABS_GITHUB];
  let tabRead = 0;
  return {
    calls,
    asked,
    deps: {
      callBrowser: async (name, args) => {
        calls.push({ name, args });
        if (name === "browser_list_tabs") {
          const text = tabs[Math.min(tabRead, tabs.length - 1)]!;
          tabRead += 1;
          return { content: [{ type: "text", text }] };
        }
        if (name === "browser_fill_form" && options.fillError) {
          return { content: [{ type: "text", text: options.fillError }], isError: true };
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
      secrets: options.secrets ?? fakeSecrets(),
      ask: async (detail) => {
        asked.push(detail);
        options.onAsk?.(detail);
        return options.outcome ?? { decision: "accept", itemId: "item_gh" };
      },
    },
  };
}

const FIELDS = [
  { target: "e12", kind: "username" },
  { target: "e13", kind: "password" },
];

test("the happy path: origin from the tab, human-picked item, fill, prose result", async () => {
  const { deps, calls, asked } = fakeDeps({ outcome: { decision: "accept", itemId: "item_work" } });
  const result = await runSecretFill(deps, { fields: FIELDS, submit: { target: "e14" } });

  expect(result.isError).toBeUndefined();
  expect(textOf(result)).toBe("Filled username and password from “GitHub (work)” on https://github.com. Submitted.");

  // The detail a human saw: the real origin, both candidates, the field kinds.
  expect(asked).toHaveLength(1);
  expect(asked[0]!.origin).toBe("https://github.com");
  expect(asked[0]!.candidates.map((candidate) => candidate.id)).toEqual(["item_gh", "item_work"]);
  expect(asked[0]!.fields).toEqual([{ kind: "username" }, { kind: "password" }]);

  // Browser traffic: tabs read before AND after approval, then fill, then submit.
  expect(calls.map((call) => call.name)).toEqual([
    "browser_list_tabs",
    "browser_list_tabs",
    "browser_fill_form",
    "browser_click",
  ]);
  const fill = calls[2]!.args as { fields: { target: string; value: string }[] };
  expect(fill.fields.map((field) => field.target)).toEqual(["e12", "e13"]);
  expect(fill.fields[1]!.value).toBe(SENTINEL);
});

test("an item hint reorders the candidates but the human's pick still wins", async () => {
  const { deps, asked } = fakeDeps({ outcome: { decision: "accept", itemId: "item_gh" } });
  const result = await runSecretFill(deps, { fields: FIELDS, item: "work" });
  expect(asked[0]!.candidates.map((candidate) => candidate.id)).toEqual(["item_work", "item_gh"]);
  expect(asked[0]!.hint).toBe("work");
  expect(textOf(result)).toContain("“GitHub”");
});

test("no page open → refused before the vault is ever consulted", async () => {
  let listed = 0;
  const { deps } = fakeDeps({
    tabs: ["nothing that parses as a tab"],
    secrets: fakeSecrets({
      listLoginCandidates: async () => {
        listed += 1;
        return { ok: true, candidates: [] };
      },
    }),
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("no http(s) page open");
  expect(listed).toBe(0);
});

test("zero domain-matched items → error to the model, NO request opened", async () => {
  const { deps, asked } = fakeDeps({ secrets: fakeSecrets({ listLoginCandidates: async () => ({ ok: true, candidates: [] }) }) });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("No 1Password Login item matches https://github.com");
  expect(asked).toHaveLength(0);
});

test("a decline is a result, not a throw, and nothing is read from the vault", async () => {
  let reads = 0;
  const { deps, calls } = fakeDeps({
    outcome: { decision: "decline" },
    secrets: fakeSecrets({
      readItemFields: async () => {
        reads += 1;
        return { ok: false, error: "unreachable" };
      },
    }),
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("declined");
  expect(reads).toBe(0);
  expect(calls.map((call) => call.name)).toEqual(["browser_list_tabs"]);
});

test("the page navigating off-domain while parked aborts the fill — approval is for a page", async () => {
  let reads = 0;
  const { deps } = fakeDeps({
    tabs: [TABS_GITHUB, TABS_EVIL],
    secrets: fakeSecrets({
      readItemFields: async () => {
        reads += 1;
        return { ok: false, error: "unreachable" };
      },
    }),
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("page changed while waiting for approval");
  expect(reads).toBe(0);
});

test("a locked vault surfaces the adapter's sentence", async () => {
  const { deps } = fakeDeps({ secrets: fakeSecrets({ listLoginCandidates: async () => ({ ok: false, error: "1Password is locked or the CLI integration is disabled." }) }) });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("locked");
});

test('kind "field" without a label is refused with instructions', async () => {
  const { deps, asked } = fakeDeps();
  const result = await runSecretFill(deps, { fields: [{ target: "e1", kind: "field" }] });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("label");
  expect(asked).toHaveLength(0);
});

// ── REDACTION — the suite this feature stands on ───────────────────────────

test("the sentinel appears in the fill_form args and NOWHERE else — detail, result, stdout, stderr", async () => {
  const stdoutWrites: string[] = [];
  const stderrWrites: string[] = [];
  const trueOut = process.stdout.write.bind(process.stdout);
  const trueErr = process.stderr.write.bind(process.stderr);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    stdoutWrites.push(String(chunk));
    return trueOut(chunk, ...rest);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (process.stderr as any).write = (chunk: any, ...rest: any[]) => {
    stderrWrites.push(String(chunk));
    return trueErr(chunk, ...rest);
  };
  try {
    const { deps, calls, asked } = fakeDeps();
    const result = await runSecretFill(deps, { fields: FIELDS, submit: { target: "e14" } });

    // The one permitted location: the local fill call's arguments.
    const fillArgs = JSON.stringify(calls.find((call) => call.name === "browser_fill_form")!.args);
    expect(fillArgs).toContain(SENTINEL);

    // Nowhere else. The request detail is what lands in the JOURNAL and on
    // the phone; the result is what enters the MODEL's context.
    expect(JSON.stringify(asked)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(stdoutWrites.join("")).not.toContain(SENTINEL);
    expect(stderrWrites.join("")).not.toContain(SENTINEL);
  } finally {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stdout as any).write = trueOut;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process.stderr as any).write = trueErr;
  }
});

test("a failing fill echoing the value back is SCRUBBED before it reaches the model", async () => {
  // Playwright MCP error prose includes the code it ran — fill('SENTINEL…').
  const { deps } = fakeDeps({ fillError: `Error: locator.fill('${SENTINEL}') timed out on ${SENTINEL}` });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  const text = textOf(result);
  expect(text).not.toContain(SENTINEL);
  expect(text).toContain("•••");
});

test("scrubSecrets masks every occurrence, longest value first", () => {
  expect(scrubSecrets(`a ${SENTINEL} b ${SENTINEL}`, [SENTINEL])).toBe("a ••• b •••");
  // A value containing another is fully covered by masking the longer first.
  expect(scrubSecrets("pw: abcdef", ["abcdef", "abc"])).toBe("pw: •••");
  expect(scrubSecrets("untouched", [""])).toBe("untouched");
});

test("the success result never echoes the transport's own fill answer", async () => {
  // Even a NON-error fill result can quote values (Playwright echoes the code
  // it ran); the orchestrator must build its answer from prose, not passthrough.
  const { deps } = fakeDeps();
  // fakeDeps' fill answers "ok" — if the orchestrator passed it through, the
  // result would say "ok" instead of the sentence below.
  const result = await runSecretFill(deps, { fields: [{ target: "e12", kind: "password" }] });
  expect(textOf(result)).toBe("Filled password from “GitHub” on https://github.com.");
});
