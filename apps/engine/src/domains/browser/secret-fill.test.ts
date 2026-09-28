import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import type { SecretAccessDetail } from "@telar/engine-client";
import { runSecretFill, scrubSecrets, type SecretAskOutcome, type SecretFillDeps } from "./secret-fill";
import { createLoginGrantStore, type LoginGrantStore } from "./login-grants";
import type { SecretsProvider } from "./onepassword";
import { textOf } from "./helpers";

const SENTINEL = "SENTINEL-s3cr3t-a1b2c3";
const USERNAME = "facundo";

const WORK = { id: "bp_00000000000000a1", label: "Work" };
const PERSONAL = { id: "bp_00000000000000b2", label: "Personal" };

type Call = { name: string; args: Record<string, unknown> };

type Page = { index?: number; uid?: string; url: string; profileId?: string; profileLabel?: string };

function tabLine(page: Page): string {
  const meta = [`tab=${page.uid ?? "tab-0"}`, "controller=idle", "opened-by=agent", "yours"];
  if (page.profileId) meta.push(`profile=${page.profileId}`);
  if (page.profileLabel) meta.push(`profile-label=${encodeURIComponent(page.profileLabel)}`);
  return `- ${page.index ?? 0}: (current) [Sign in](${page.url}) {${meta.join(", ")}}`;
}

const githubPage = (): Page => ({ url: "https://github.com/login", profileId: WORK.id, profileLabel: WORK.label });

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
  page?: Page;
  rawTabs?: string;
  secrets?: SecretsProvider;
  outcome?: SecretAskOutcome;
  onAsk?: (detail: SecretAccessDetail) => void | Promise<void>;
  onVaultRead?: () => void | Promise<void>;
  onTabRead?: (nth: number) => void;
  fillError?: string;
  sessionProfile?: { id: string; label?: string; account?: string } | null;
  grants?: LoginGrantStore;
} = {}): { deps: SecretFillDeps; calls: Call[]; asked: SecretAccessDetail[]; page: Page } {
  const calls: Call[] = [];
  const asked: SecretAccessDetail[] = [];
  const page = options.page ?? githubPage();
  let tabReads = 0;
  const baseSecrets = options.secrets ?? fakeSecrets();
  return {
    calls,
    asked,
    page,
    deps: {
      ...(options.sessionProfile !== undefined
        ? { profile: async () => options.sessionProfile ?? null }
        : { profile: async () => (page.profileId ? { id: page.profileId, ...(page.profileLabel ? { label: page.profileLabel } : {}) } : null) }),
      ...(options.grants ? { grants: options.grants } : {}),
      callBrowser: async (name, args) => {
        calls.push({ name, args });
        if (name === "browser_tabs") {
          tabReads += 1;
          options.onTabRead?.(tabReads);
          return { content: [{ type: "text", text: options.rawTabs ?? tabLine(page) }] };
        }
        if (name === "browser_fill_form" && options.fillError) {
          return { content: [{ type: "text", text: options.fillError }], isError: true };
        }
        return { content: [{ type: "text", text: "ok" }] };
      },
      secrets: {
        ...baseSecrets,
        readItemFields: async (id, wants) => {
          await options.onVaultRead?.();
          return baseSecrets.readItemFields(id, wants);
        },
      },
      ask: async (detail) => {
        asked.push(detail);
        await options.onAsk?.(detail);
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

  expect(asked).toHaveLength(1);
  expect(asked[0]!.origin).toBe("https://github.com");
  expect(asked[0]!.candidates.map((candidate) => candidate.id)).toEqual(["item_gh", "item_work"]);
  expect(asked[0]!.fields).toEqual([{ kind: "username" }, { kind: "password" }]);

  expect(calls.map((call) => call.name)).toEqual([
    "browser_tabs",
    "browser_tabs",
    "browser_tabs",
    "browser_fill_form",
    "browser_tabs",
    "browser_click",
  ]);
  const fill = calls.find((call) => call.name === "browser_fill_form")!.args as { fields: { target: string; value: string }[] };
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
    rawTabs: "nothing that parses as a tab",
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
  expect(calls.map((call) => call.name)).toEqual(["browser_tabs"]);
});

test("the page navigating off-domain while parked aborts the fill — approval is for a page", async () => {
  let reads = 0;
  const page = githubPage();
  const { deps } = fakeDeps({
    page,
    onAsk: () => { page.url = "https://evil.example/login"; },
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

function grantStore(): LoginGrantStore {
  return createLoginGrantStore(fs.mkdtempSync(path.join(os.tmpdir(), "telar-grants-")));
}

function rememberUsernameAndPassword(grants: LoginGrantStore, profileId = WORK.id, origin = "https://github.com") {
  return grants.remember({
    profileId,
    profileLabel: "Work",
    origin,
    itemId: "item_gh",
    itemTitle: "GitHub",
    fields: [{ kind: "username" }, { kind: "password" }],
  });
}

test("the opt-in is what stores a grant: unticked stores nothing, ticked stores exactly what was approved", async () => {
  const grants = grantStore();
  const plain = fakeDeps({ grants, outcome: { decision: "accept", itemId: "item_gh" } });
  await runSecretFill(plain.deps, { fields: FIELDS });
  expect(grants.list()).toHaveLength(0);

  const ticked = fakeDeps({ grants, outcome: { decision: "accept", itemId: "item_gh", remember: true } });
  const result = await runSecretFill(ticked.deps, { fields: FIELDS });
  expect(result.isError).toBeUndefined();
  const [grant] = grants.list();
  expect(grant).toMatchObject({
    profileId: WORK.id,
    origin: "https://github.com",
    itemId: "item_gh",
    itemTitle: "GitHub",
    fields: [{ kind: "username" }, { kind: "password" }],
  });
  expect(JSON.stringify(grants.list())).not.toContain(SENTINEL);
});

test("a grant is only written when the fill actually worked", async () => {
  const grants = grantStore();
  const { deps } = fakeDeps({
    grants,
    outcome: { decision: "accept", itemId: "item_gh", remember: true },
    fillError: "could not find the field",
  });
  expect((await runSecretFill(deps, { fields: FIELDS })).isError).toBe(true);
  expect(grants.list()).toHaveLength(0);
});

test("a matching grant fills without asking anyone, and the card is never opened", async () => {
  const grants = grantStore();
  rememberUsernameAndPassword(grants);
  const { deps, asked, calls } = fakeDeps({ grants });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(0);
  expect(result.isError).toBeUndefined();
  expect(textOf(result)).toContain("Used a login you allowed for this profile.");
  const fill = calls.find((call) => call.name === "browser_fill_form")!.args as { fields: { value: string }[] };
  expect(fill.fields[1]!.value).toBe(SENTINEL);
  expect(grants.list()[0]!.lastUsedAt).toBeGreaterThan(0);
});

test("a grant is scoped to ONE profile: the same site in another identity asks again", async () => {
  const grants = grantStore();
  rememberUsernameAndPassword(grants, WORK.id);
  const { deps, asked } = fakeDeps({ page: { url: "https://github.com/login", profileId: PERSONAL.id, profileLabel: PERSONAL.label }, grants });
  await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.profile).toEqual(PERSONAL);
});

test("a grant is scoped to ONE exact origin — not the registrable domain", async () => {
  const grants = grantStore();
  rememberUsernameAndPassword(grants, WORK.id, "https://gist.github.com");
  const { deps, asked } = fakeDeps({ grants });
  await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(1);
});

test("a grant never widens to more fields than the human saw — a one-time code asks again", async () => {
  const grants = grantStore();
  rememberUsernameAndPassword(grants);
  const { deps, asked } = fakeDeps({ grants });
  await runSecretFill(deps, { fields: [...FIELDS, { target: "e15", kind: "otp" }] });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.fields).toEqual([{ kind: "username" }, { kind: "password" }, { kind: "otp" }]);
  const narrower = fakeDeps({ grants });
  await runSecretFill(narrower.deps, { fields: [{ target: "e13", kind: "password" }] });
  expect(narrower.asked).toHaveLength(0);
});

test("a labelled field matches only under the same label", async () => {
  const grants = grantStore();
  grants.remember({
    profileId: WORK.id,
    origin: "https://github.com",
    itemId: "item_gh",
    itemTitle: "GitHub",
    fields: [{ kind: "field", label: "Employee ID" }],
  });
  const same = fakeDeps({ grants });
  await runSecretFill(same.deps, { fields: [{ target: "e1", kind: "field", label: "employee id" }] });
  expect(same.asked).toHaveLength(0);
  const other = fakeDeps({ grants });
  await runSecretFill(other.deps, { fields: [{ target: "e1", kind: "field", label: "Recovery code" }] });
  expect(other.asked).toHaveLength(1);
});

test("no title match and no first-candidate fallback: a grant whose item is gone asks a human", async () => {
  const grants = grantStore();
  grants.remember({
    profileId: WORK.id,
    origin: "https://github.com",
    itemId: "item_deleted",
    itemTitle: "GitHub",
    fields: [{ kind: "username" }, { kind: "password" }],
  });
  const { deps, asked } = fakeDeps({ grants });
  await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(1);
});

test("the page moving to another host of the same domain denies a remembered fill (an approval widened to a domain does not)", async () => {
  const grants = grantStore();
  rememberUsernameAndPassword(grants);
  const page = githubPage();
  const { deps } = fakeDeps({ page, grants, onVaultRead: () => { page.url = "https://gist.github.com/x"; } });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("page changed while preparing the fill");
});

test("with no identity on the tab nothing is remembered and nothing remembered is spent", async () => {
  const grants = grantStore();
  rememberUsernameAndPassword(grants);
  const { deps, asked } = fakeDeps({
    page: { url: "https://github.com/login" },
    grants,
    outcome: { decision: "accept", itemId: "item_gh", remember: true },
  });
  await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.profile).toBeUndefined();
  expect(grants.list()).toHaveLength(1);
});

test("the grant is matched against the TAB's profile, not the session's next-tab default", async () => {
  const grants = grantStore();
  rememberUsernameAndPassword(grants, WORK.id);
  const { deps, asked, calls } = fakeDeps({ grants, sessionProfile: PERSONAL });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(0);
  expect(result.isError).toBeUndefined();
  expect(calls.some((call) => call.name === "browser_fill_form")).toBe(true);
});

test("a tab in another profile than the grant asks, even when the session default matches the grant", async () => {
  const grants = grantStore();
  rememberUsernameAndPassword(grants, WORK.id);
  const { deps, asked } = fakeDeps({
    page: { url: "https://github.com/login", profileId: PERSONAL.id, profileLabel: PERSONAL.label },
    grants,
    sessionProfile: WORK,
  });
  await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.profile).toEqual({ id: PERSONAL.id, label: PERSONAL.label });
});

test("the fill and the submit are addressed to the tab that was checked", async () => {
  const { deps, calls } = fakeDeps({ page: { ...githubPage(), index: 3 } });
  await runSecretFill(deps, { fields: FIELDS, submit: { target: "e14" } });
  expect((calls.find((call) => call.name === "browser_fill_form")!.args as { tabId: number }).tabId).toBe(3);
  expect((calls.find((call) => call.name === "browser_click")!.args as { tabId: number }).tabId).toBe(3);
});

test("a tab set that shifted under the fill denies it — the index is not blindly reused", async () => {
  const page = githubPage();
  const { deps, calls } = fakeDeps({ page, onVaultRead: () => { page.index = 1; } });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("tabs changed");
  expect(calls.map((call) => call.name)).not.toContain("browser_fill_form");
});

test("a navigation DURING the vault read denies the fill and the values are dropped unused", async () => {
  const page = githubPage();
  const { deps, calls } = fakeDeps({ page, onVaultRead: () => { page.url = "https://evil.example/login"; } });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("page changed");
  expect(calls.map((call) => call.name)).not.toContain("browser_fill_form");
  expect(JSON.stringify(calls)).not.toContain(SENTINEL);
});

test("a profile switch DURING the vault read denies the fill", async () => {
  const page = githubPage();
  const { deps, calls } = fakeDeps({
    page,
    onVaultRead: () => { page.profileId = PERSONAL.id; page.profileLabel = PERSONAL.label; },
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("no longer in the profile");
  expect(calls.map((call) => call.name)).not.toContain("browser_fill_form");
});

test("a revoke DURING the vault read denies the remembered fill", async () => {
  const grants = grantStore();
  const grant = rememberUsernameAndPassword(grants);
  const { deps, asked, calls } = fakeDeps({ grants, onVaultRead: () => { grants.revoke(grant.id); } });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(0);
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("revoked");
  expect(calls.map((call) => call.name)).not.toContain("browser_fill_form");
});

test("a revoke BEFORE the vault read denies the fill without opening the vault at all", async () => {
  const grants = grantStore();
  const grant = rememberUsernameAndPassword(grants);
  let reads = 0;
  const { deps } = fakeDeps({
    grants,
    onTabRead: (nth) => { if (nth === 2) grants.revoke(grant.id); },
    secrets: fakeSecrets({ readItemFields: async () => { reads += 1; return { ok: false, error: "unreachable" }; } }),
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("revoked");
  expect(reads).toBe(0);
});

test("a navigation during the vault read on the HUMAN path also denies, and stores no grant", async () => {
  const grants = grantStore();
  const page = githubPage();
  const { deps } = fakeDeps({
    page,
    grants,
    outcome: { decision: "accept", itemId: "item_gh", remember: true },
    onVaultRead: () => { page.url = "https://evil.example/login"; },
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(grants.list()).toHaveLength(0);
});

const REMEMBER = { decision: "accept" as const, itemId: "item_gh", remember: true };

test("ticking remember holds the fill to the EXACT origin the card showed — a same-domain move denies it", async () => {
  const grants = grantStore();
  const page = githubPage();
  const { deps, calls } = fakeDeps({
    page,
    grants,
    outcome: REMEMBER,
    onAsk: () => { page.url = "https://gist.github.com/login"; },
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(calls.map((call) => call.name)).not.toContain("browser_fill_form");
  expect(grants.list()).toHaveLength(0);
});

test("the same same-domain move WITHOUT the opt-in still fills, and still stores nothing", async () => {
  const grants = grantStore();
  const page = githubPage();
  const { deps } = fakeDeps({
    page,
    grants,
    outcome: { decision: "accept", itemId: "item_gh" },
    onAsk: () => { page.url = "https://gist.github.com/login"; },
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBeUndefined();
  expect(grants.list()).toHaveLength(0);
});

test("a same-domain move DURING the vault read denies a first remember and stores nothing", async () => {
  const grants = grantStore();
  const page = githubPage();
  const { deps, calls } = fakeDeps({
    page,
    grants,
    outcome: REMEMBER,
    onVaultRead: () => { page.url = "https://gist.github.com/login"; },
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(calls.map((call) => call.name)).not.toContain("browser_fill_form");
  expect(grants.list()).toHaveLength(0);
});

test("a move AFTER the values went out keeps the fill but creates no standing permission", async () => {
  const grants = grantStore();
  const page = githubPage();
  const { deps } = fakeDeps({
    page,
    grants,
    outcome: REMEMBER,
    onTabRead: (nth) => { if (nth === 4) page.url = "https://gist.github.com/x"; },
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBeUndefined();
  expect(textOf(result)).not.toContain("Allowed for this profile");
  expect(grants.list()).toHaveLength(0);
});

test("an unmoved first remember stores exactly the origin the card named", async () => {
  const grants = grantStore();
  const { deps } = fakeDeps({ page: { ...githubPage(), url: "https://github.com/session/new" }, grants, outcome: REMEMBER });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBeUndefined();
  expect(grants.list()[0]!.origin).toBe("https://github.com");
  expect(textOf(result)).toContain("Allowed for this profile from now on.");
});

test("another tab shifted into the same index is refused, even at the same origin and profile", async () => {
  const page: Page = { ...githubPage(), uid: "tab-a" };
  const { deps, calls } = fakeDeps({
    page,
    onVaultRead: () => { page.uid = "tab-b"; },
  });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("tabs changed");
  expect(calls.map((call) => call.name)).not.toContain("browser_fill_form");
});

test("a revoke while the form is being filled stops the submit", async () => {
  const grants = grantStore();
  const grant = rememberUsernameAndPassword(grants);
  const { deps, calls } = fakeDeps({
    grants,
    onTabRead: (nth) => { if (nth === 4) grants.revoke(grant.id); },
  });
  const result = await runSecretFill(deps, { fields: FIELDS, submit: { target: "e14" } });
  expect(result.isError).toBe(true);
  expect(textOf(result)).toContain("did not submit");
  expect(textOf(result)).toContain("revoked");
  expect(calls.map((call) => call.name)).not.toContain("browser_click");
});

function rememberBoth(grants: LoginGrantStore) {
  rememberUsernameAndPassword(grants);
  grants.remember({
    profileId: WORK.id,
    origin: "https://github.com",
    itemId: "item_work",
    itemTitle: "GitHub (work)",
    fields: [{ kind: "username" }, { kind: "password" }],
  });
}

test("two authorized logins and nothing to choose between them: a human is asked, never the first", async () => {
  const grants = grantStore();
  rememberBoth(grants);
  const { deps, asked } = fakeDeps({ grants });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.candidates.map((candidate) => candidate.id)).toEqual(["item_gh", "item_work"]);
  expect(textOf(result)).not.toContain("Used a login you allowed");
});

test("an exact item selection among two authorized logins is honoured without asking", async () => {
  const grants = grantStore();
  rememberBoth(grants);
  const byId = fakeDeps({ grants });
  expect(textOf(await runSecretFill(byId.deps, { fields: FIELDS, item: "item_work" }))).toContain("“GitHub (work)”");
  expect(byId.asked).toHaveLength(0);

  const byTitle = fakeDeps({ grants });
  expect(textOf(await runSecretFill(byTitle.deps, { fields: FIELDS, item: "GitHub (work)" }))).toContain("“GitHub (work)”");
  expect(byTitle.asked).toHaveLength(0);
});

test("an AMBIGUOUS item hint asks rather than guessing between authorized logins", async () => {
  const grants = grantStore();
  rememberBoth(grants);
  const { deps, asked } = fakeDeps({ grants });
  await runSecretFill(deps, { fields: FIELDS, item: "hub" });
  expect(asked).toHaveLength(1);
  expect(asked[0]!.hint).toBe("hub");
});

test("an item selection that is NOT authorized asks, even when another item is", async () => {
  const grants = grantStore();
  rememberUsernameAndPassword(grants);
  const { deps, asked } = fakeDeps({ grants });
  await runSecretFill(deps, { fields: FIELDS, item: "item_work" });
  expect(asked).toHaveLength(1);
});

test("the human's own pick is what gets filled when a grant existed but did not decide", async () => {
  const grants = grantStore();
  rememberBoth(grants);
  const { deps, asked } = fakeDeps({ grants, outcome: { decision: "accept", itemId: "item_work" } });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(1);
  expect(textOf(result)).toBe("Filled username and password from “GitHub (work)” on https://github.com.");
  expect(textOf(result)).not.toContain("Used a login you allowed");
  expect(grants.list().every((grant) => grant.lastUsedAt === undefined)).toBe(true);
});

test("a grant whose item is gone falls back to the human WITHOUT claiming it was used", async () => {
  const grants = grantStore();
  grants.remember({
    profileId: WORK.id,
    origin: "https://github.com",
    itemId: "item_deleted",
    itemTitle: "GitHub",
    fields: [{ kind: "username" }, { kind: "password" }],
  });
  const { deps, asked } = fakeDeps({ grants, outcome: { decision: "accept", itemId: "item_gh" } });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(asked).toHaveLength(1);
  expect(textOf(result)).not.toContain("Used a login you allowed");
  expect(grants.list()[0]!.lastUsedAt).toBeUndefined();
});

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

    const fillArgs = JSON.stringify(calls.find((call) => call.name === "browser_fill_form")!.args);
    expect(fillArgs).toContain(SENTINEL);

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
  const { deps } = fakeDeps({ fillError: `Error: locator.fill('${SENTINEL}') timed out on ${SENTINEL}` });
  const result = await runSecretFill(deps, { fields: FIELDS });
  expect(result.isError).toBe(true);
  const text = textOf(result);
  expect(text).not.toContain(SENTINEL);
  expect(text).toContain("•••");
});

test("scrubSecrets masks every occurrence, longest value first", () => {
  expect(scrubSecrets(`a ${SENTINEL} b ${SENTINEL}`, [SENTINEL])).toBe("a ••• b •••");
  expect(scrubSecrets("pw: abcdef", ["abcdef", "abc"])).toBe("pw: •••");
  expect(scrubSecrets("untouched", [""])).toBe("untouched");
});

test("the success result never echoes the transport's own fill answer", async () => {
  const { deps } = fakeDeps();
  const result = await runSecretFill(deps, { fields: [{ target: "e12", kind: "password" }] });
  expect(textOf(result)).toBe("Filled password from “GitHub” on https://github.com.");
});
