import type { SecretAccessDetail, SecretCandidate } from "@telar/engine-client";
import { parseBrowserTabs, textOf } from "./helpers";
import { registrableDomainOfUrl, type SecretFieldWant, type SecretsProvider } from "./onepassword";
import type { LoginGrant, LoginGrantStore } from "./login-grants";
import { BrowserToolInputError, BrowserToolResult, parseBrowserToolInput } from "./tools";

export type SecretAskOutcome = {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
  itemId?: string;
  remember?: boolean;
};

export type SecretFillDeps = {
  callBrowser(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>;
  secrets: SecretsProvider;
  ask(detail: SecretAccessDetail): Promise<SecretAskOutcome>;
  profile?(): Promise<{ id: string; label?: string; account?: string } | null>;
  grants?: LoginGrantStore;
};

function asToolResult(raw: { content: unknown[]; isError?: boolean }): BrowserToolResult {
  const parsed = BrowserToolResult.safeParse(raw);
  return parsed.success ? parsed.data : { content: [], isError: true };
}

function errorResult(text: string): BrowserToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

type ParsedField = { target: string; element?: string; kind: "username" | "password" | "otp" | "field"; label?: string };
type ParsedArgs = { fields: ParsedField[]; item?: string; submit?: { target: string; element?: string } };

type FillTarget = {
  index: number;
  uid?: string;
  url: string;
  origin: string;
  profileId?: string;
  profileLabel?: string;
};

async function readFillTarget(callBrowser: SecretFillDeps["callBrowser"]): Promise<FillTarget | null> {
  const result = asToolResult(await callBrowser("browser_list_tabs", {}));
  if (result.isError) return null;
  const tabs = parseBrowserTabs(textOf(result));
  const tab = tabs.find((candidate) => candidate.agentFocus) ?? tabs.find((candidate) => candidate.active) ?? tabs[0];
  if (!tab || tab.url === "about:blank") return null;
  const origin = originOf(tab.url);
  if (!origin) return null;
  return {
    index: tab.index,
    ...(tab.tabUid ? { uid: tab.tabUid } : {}),
    url: tab.url,
    origin,
    ...(tab.profileId ? { profileId: tab.profileId } : {}),
    ...(tab.profileLabel ? { profileLabel: tab.profileLabel } : {}),
  };
}

async function confirmTarget(
  callBrowser: SecretFillDeps["callBrowser"],
  expected: FillTarget,
  { originMustMatchExactly }: { originMustMatchExactly: boolean },
): Promise<string | null> {
  const now = await readFillTarget(callBrowser);
  if (!now) return "The browser has no page open to fill credentials into any more — credentials were not filled.";
  if (now.index !== expected.index) return "The browser's tabs changed while preparing the fill — credentials were not filled.";
  if (expected.uid !== undefined && now.uid !== expected.uid) {
    return "The browser's tabs changed while preparing the fill — credentials were not filled.";
  }
  if (originMustMatchExactly) {
    if (now.origin !== expected.origin) return "The page changed while preparing the fill — the remembered login was not used.";
  } else if (registrableDomainOfUrl(now.origin) !== registrableDomainOfUrl(expected.origin)) {
    return "The page changed while waiting for approval — credentials were not filled.";
  }
  if (expected.profileId !== undefined && now.profileId !== expected.profileId) {
    return "This browser is no longer in the profile that login was allowed for — credentials were not filled.";
  }
  if (expected.profileId === undefined && now.profileId !== undefined) {
    return "The browser reported a different identity while preparing the fill — credentials were not filled.";
  }
  return null;
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export function scrubSecrets(text: string, values: readonly string[]): string {
  let scrubbed = text;
  for (const value of [...values].sort((a, b) => b.length - a.length)) {
    if (value.length === 0) continue;
    scrubbed = scrubbed.split(value).join("•••");
  }
  return scrubbed;
}

export async function runSecretFill(deps: SecretFillDeps, rawArgs: Record<string, unknown>): Promise<BrowserToolResult> {
  let args: ParsedArgs;
  try {
    args = parseBrowserToolInput("browser_fill_secret", rawArgs) as ParsedArgs;
  } catch (error) {
    if (error instanceof BrowserToolInputError) return errorResult(error.message);
    throw error;
  }
  for (const field of args.fields) {
    if (field.kind === "field" && !field.label) {
      return errorResult("A field of kind \"field\" needs a `label` naming the 1Password field to read.");
    }
  }

  const target = await readFillTarget(deps.callBrowser);
  if (!target) {
    return errorResult("The browser has no http(s) page open to fill credentials into. Navigate to the login page first.");
  }
  const origin = target.origin;
  const domain = registrableDomainOfUrl(origin);
  if (!domain) {
    return errorResult("The browser has no http(s) page open to fill credentials into. Navigate to the login page first.");
  }

  const listed = await deps.secrets.listLoginCandidates(origin);
  if (!listed.ok) return errorResult(listed.error);
  if (listed.candidates.length === 0) {
    return errorResult(`No 1Password Login item matches ${origin}. The human can add the site to an item's website field and retry.`);
  }
  const candidates = reorderByHint(listed.candidates, args.item);

  const wants: SecretFieldWant[] = args.fields.map((field) => ({ kind: field.kind, ...(field.label ? { label: field.label } : {}) }));
  const sessionProfile = deps.profile ? await deps.profile() : null;
  const profile = target.profileId
    ? {
        id: target.profileId,
        ...(target.profileLabel
          ? { label: target.profileLabel }
          : sessionProfile && sessionProfile.id === target.profileId && sessionProfile.label
            ? { label: sessionProfile.label }
            : {}),
        ...(sessionProfile && sessionProfile.id === target.profileId && sessionProfile.account ? { account: sessionProfile.account } : {}),
      }
    : null;

  const authorized = profile && deps.grants ? deps.grants.findAll({ profileId: profile.id, origin, wants }) : [];
  const authorizedCandidates = candidates.filter((candidate) => authorized.some((grant) => grant.itemId === candidate.id));
  const selected = args.item ? resolveExactItem(candidates, args.item) : undefined;

  let chosen: SecretCandidate;
  let usedGrant: LoginGrant | null = null;
  let rememberThis = false;
  if (selected) {
    usedGrant = authorized.find((grant) => grant.itemId === selected.id) ?? null;
  } else if (!args.item && authorizedCandidates.length === 1) {
    usedGrant = authorized.find((grant) => grant.itemId === authorizedCandidates[0]!.id) ?? null;
  }

  if (usedGrant) {
    chosen = candidates.find((candidate) => candidate.id === usedGrant!.itemId)!;
  } else {
    const outcome = await deps.ask({
      origin,
      fields: args.fields.map((field) => ({ kind: field.kind, ...(field.label ? { label: field.label } : {}) })),
      candidates,
      ...(args.item ? { hint: args.item } : {}),
      ...(profile ? { profile } : {}),
    });
    if (outcome.decision !== "accept" && outcome.decision !== "acceptForSession") {
      return errorResult("The human declined to fill credentials from 1Password.");
    }
    chosen = candidates.find((candidate) => candidate.id === outcome.itemId) ?? candidates[0]!;
    rememberThis = outcome.remember === true && Boolean(profile) && Boolean(deps.grants);
  }

  const exactOriginRequired = Boolean(usedGrant) || rememberThis;

  const beforeRead = await confirmTarget(deps.callBrowser, target, { originMustMatchExactly: exactOriginRequired });
  if (beforeRead) return errorResult(beforeRead);
  if (usedGrant && !stillAuthorizes(deps, usedGrant, wants)) {
    return errorResult("That remembered login was revoked — credentials were not filled.");
  }

  const read = await deps.secrets.readItemFields(chosen.id, wants);
  if (!read.ok) return errorResult(read.error);
  const values = read.values.map((entry) => entry.value);

  const beforeDispatch = await confirmTarget(deps.callBrowser, target, { originMustMatchExactly: exactOriginRequired });
  if (beforeDispatch) return errorResult(beforeDispatch);
  if (usedGrant && !stillAuthorizes(deps, usedGrant, wants)) {
    return errorResult("That remembered login was revoked — credentials were not filled.");
  }

  const fill = asToolResult(await deps.callBrowser("browser_fill_form", {
    tabId: target.index,
    fields: args.fields.map((field, index) => ({
      target: field.target,
      ...(field.element ? { element: field.element } : {}),
      name: field.kind === "field" ? field.label! : field.kind,
      type: "textbox",
      value: read.values[index]!.value,
    })),
  }));
  if (fill.isError) {
    return errorResult(`Filling the form failed: ${scrubSecrets(textOf(fill), values)}`);
  }

  let submitted = false;
  if (args.submit) {
    const beforeSubmit = await confirmTarget(deps.callBrowser, target, { originMustMatchExactly: exactOriginRequired });
    if (beforeSubmit) {
      return errorResult(`Filled ${describeFields(args.fields)} from “${chosen.title}” on ${origin}, but did not submit: ${beforeSubmit}`);
    }
    if (usedGrant && !stillAuthorizes(deps, usedGrant, wants)) {
      return errorResult(
        `Filled ${describeFields(args.fields)} from “${chosen.title}” on ${origin}, but did not submit: that remembered login was revoked.`,
      );
    }
    const click = asToolResult(await deps.callBrowser("browser_click", {
      tabId: target.index,
      target: args.submit.target,
      ...(args.submit.element ? { element: args.submit.element } : {}),
    }));
    if (click.isError) {
      return errorResult(
        `Filled ${describeFields(args.fields)} from “${chosen.title}” on ${origin}, but pressing the submit control failed: ${scrubSecrets(textOf(click), values)}`,
      );
    }
    submitted = true;
  }

  if (rememberThis && profile && deps.grants) {
    const landed = await readFillTarget(deps.callBrowser);
    const unmoved =
      landed !== null &&
      landed.index === target.index &&
      landed.uid === target.uid &&
      landed.profileId === target.profileId &&
      landed.origin === origin;
    if (unmoved) {
      try {
        deps.grants.remember({
          profileId: profile.id,
          ...(profile.label ? { profileLabel: profile.label } : {}),
          origin,
          itemId: chosen.id,
          itemTitle: chosen.title,
          ...(chosen.vault ? { vault: chosen.vault } : {}),
          fields: wants.map((want) => ({ kind: want.kind, ...(want.label ? { label: want.label } : {}) })),
        });
      } catch {
      }
    } else {
      rememberThis = false;
    }
  }
  if (usedGrant) {
    try { deps.grants?.touch(usedGrant.id); } catch { }
  }

  return {
    content: [
      {
        type: "text",
        text: `Filled ${describeFields(args.fields)} from “${chosen.title}” on ${origin}.${submitted ? " Submitted." : ""}${
          usedGrant ? " Used a login you allowed for this profile." : rememberThis ? " Allowed for this profile from now on." : ""
        }`,
      },
    ],
  };
}

function describeFields(fields: readonly ParsedField[]): string {
  return fields.map((field) => (field.kind === "field" ? `“${field.label}”` : field.kind)).join(" and ");
}

function stillAuthorizes(deps: SecretFillDeps, grant: LoginGrant, wants: readonly SecretFieldWant[]): boolean {
  return Boolean(deps.grants?.find({ profileId: grant.profileId, origin: grant.origin, itemId: grant.itemId, wants }));
}

function resolveExactItem(candidates: readonly SecretCandidate[], hint: string): SecretCandidate | undefined {
  const needle = hint.trim().toLowerCase();
  if (!needle) return undefined;
  const byId = candidates.find((candidate) => candidate.id === hint.trim());
  if (byId) return byId;
  const byTitle = candidates.filter((candidate) => candidate.title.trim().toLowerCase() === needle);
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

function reorderByHint(candidates: SecretCandidate[], hint: string | undefined): SecretCandidate[] {
  if (!hint) return candidates;
  const needle = hint.trim().toLowerCase();
  if (!needle) return candidates;
  const index = candidates.findIndex(
    (candidate) => candidate.id === hint || candidate.title.toLowerCase() === needle || candidate.title.toLowerCase().includes(needle),
  );
  if (index <= 0) return candidates;
  const copy = [...candidates];
  const [match] = copy.splice(index, 1);
  copy.unshift(match!);
  return copy;
}
