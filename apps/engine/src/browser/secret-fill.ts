/**
 * The credential-fill orchestrator: `browser_fill_secret` from parsed args to
 * a prose result, with the secret alive only between the vault read and the
 * fill call.
 *
 * WHERE THE SECRET MAY EXIST is the whole design, so it is stated here once:
 *   1. inside `op` and the pipes `secrets.readItemFields` reads from;
 *   2. in this function's locals;
 *   3. in the `browser_fill_form` arguments handed to the local Playwright
 *      MCP process over stdio.
 * It may NOT exist in: the `secret_access` request detail (built from
 * metadata only), the tool result (built fresh from prose below), any thrown
 * error, or anything logged. The transport's own answer to the fill call is
 * DROPPED UNREAD on success and SCRUBBED on failure, because Playwright MCP
 * echoes the code it ran — `fill('hunter2')` — into its results.
 *
 * A REMEMBERED AUTHORIZATION SKIPS TELAR'S CARD, AND NOTHING ELSE. When a
 * previous fill was approved with the card's opt-in ticked, a later fill that
 * matches it EXACTLY — same browser profile, same exact origin, same vault
 * item, and no field kind the human did not see — proceeds without asking.
 * Everything below still happens: the origin is read from the engine's own tab
 * state, the item must still be in the domain-matched candidate list, the
 * profile and origin are re-read after every await, the grant is re-checked for
 * revocation, and `op` still enforces the vault's lock. What the tick removed
 * is one approval card, not one safeguard. See `secrets/login-grants.ts`.
 *
 * DOMAIN BINDING IS READ FROM THE BROWSER, TWICE. The origin comes from the
 * engine's own tab state (the model cannot claim a different page), candidates
 * are filtered to items whose website matches it by registrable domain, and
 * the origin is re-read after the human approves — an approval is for a page,
 * not a token the tab can spend somewhere else after navigating.
 */
import type { SecretAccessDetail, SecretCandidate } from "@telar/engine-client";
import { parseBrowserTabs, textOf } from "./helpers";
import { registrableDomainOfUrl, type SecretFieldWant, type SecretsProvider } from "../secrets/onepassword";
import type { LoginGrant, LoginGrantStore } from "../secrets/login-grants";
import { BrowserToolInputError, BrowserToolResult, parseBrowserToolInput } from "./tools";

export type SecretAskOutcome = {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
  /** The human's item pick — `answers.item` of the resolved request. */
  itemId?: string;
  /** The card's unchecked opt-in, ticked: remember THIS authorization. */
  remember?: boolean;
};

export type SecretFillDeps = {
  /** The scope-bound browser, exactly the socket's own `capability.call`. The
   *  loose content type mirrors `BrowserSocketCapability`; results are parsed
   *  through `BrowserToolResult` before anything reads them. */
  callBrowser(name: string, args: Record<string, unknown>): Promise<{ content: unknown[]; isError?: boolean }>;
  secrets: SecretsProvider;
  /** Open the `secret_access` request and wait for a human. NEVER resolved by
   *  policy — `autoResolution` returns null for this kind in every mode. */
  ask(detail: SecretAccessDetail): Promise<SecretAskOutcome>;
  /**
   * WHICH BROWSER IDENTITY this scope is running under, asked FRESH every time
   * (twice per fill: once to look a grant up, once after the vault read to
   * prove it did not change under the awaits). Absent, or answering null, means
   * no identity is known — and then nothing is remembered and nothing
   * remembered is spent: the human is asked, exactly as before.
   */
  profile?(): Promise<{ id: string; label?: string; account?: string } | null>;
  /** Remembered login authorizations — see `secrets/login-grants.ts`. Absent
   *  means the feature is simply not wired for this turn, and every fill asks. */
  grants?: LoginGrantStore;
};

/** Narrow a capability result to the parsed shape, treating an unparseable
 *  one as an error result rather than letting `unknown` blocks flow onward. */
function asToolResult(raw: { content: unknown[]; isError?: boolean }): BrowserToolResult {
  const parsed = BrowserToolResult.safeParse(raw);
  return parsed.success ? parsed.data : { content: [], isError: true };
}

function errorResult(text: string): BrowserToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

type ParsedField = { target: string; element?: string; kind: "username" | "password" | "otp" | "field"; label?: string };
type ParsedArgs = { fields: ParsedField[]; item?: string; submit?: { target: string; element?: string } };

/**
 * THE TAB THIS FILL WILL LAND IN — its address, its origin, and the browser
 * profile it is signed into.
 *
 * THE AGENT'S TAB, NOT THE HUMAN'S VIEW. The human's view moves independently,
 * so reading the `(current)` tab here would bind the approval to one page while
 * typing the credential into another. `agentFocus` is absent on hosts with no
 * such distinction (the headless runtime), where the human's tab IS the
 * agent's.
 *
 * THE PROFILE IS THE TAB'S, NOT THE SESSION'S. A person may switch a session's
 * profile with tabs open: the open tabs keep the identity they were signed into
 * and only the NEXT tab uses the new one. Reading the session's default here
 * would authorize a fill against an identity this page is not in.
 */
type FillTarget = {
  /**
   * How the host addresses this tab (`tabId`), so the checks and the write name
   * the same page rather than both saying "whatever is focused".
   *
   * IT IS A POSITION, NOT AN IDENTITY — `tabAt` indexes the scope's tab list —
   * so closing a tab renumbers everything after it. That is what `uid` is for.
   */
  index: number;
  /** The host's own id for the tab, when it reports one. Compared across every
   *  await so a renumbered index cannot substitute another page. */
  uid?: string;
  url: string;
  origin: string;
  /** Absent means the host does not name identities — never "the default one". */
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

/**
 * IS THIS STILL THE SAME PAGE, IN THE SAME IDENTITY? Re-read and compared
 * before the vault is opened AND again immediately before the values are
 * dispatched, because every one of these can change under an await: the page
 * navigates, the person switches the session's profile, a tab opens or closes
 * and shifts the index.
 *
 * FAILS CLOSED IN EVERY DIRECTION. A tab that cannot be read, an index that now
 * holds a different page, a profile that is now unknown — all deny.
 * `originMustMatchExactly` is true on the remembered path, where the
 * authorization was given for one exact origin; a human's approval was given
 * for a page and stays bound to its registrable domain.
 */
async function confirmTarget(
  callBrowser: SecretFillDeps["callBrowser"],
  expected: FillTarget,
  { originMustMatchExactly }: { originMustMatchExactly: boolean },
): Promise<string | null> {
  const now = await readFillTarget(callBrowser);
  if (!now) return "The browser has no page open to fill credentials into any more — credentials were not filled.";
  if (now.index !== expected.index) return "The browser's tabs changed while preparing the fill — credentials were not filled.";
  // The index matched — but the index is a POSITION. If the host names its
  // tabs, the name has to match too, or a closed tab has quietly shifted
  // another page into the slot this fill was approved for.
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

/** Replace every secret value in transport prose with a mask. Longer values
 *  first so a value that contains another is fully covered. */
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

  // ── where does this fill land, and in whose identity? ───────────────────
  const target = await readFillTarget(deps.callBrowser);
  if (!target) {
    return errorResult("The browser has no http(s) page open to fill credentials into. Navigate to the login page first.");
  }
  const origin = target.origin;
  const domain = registrableDomainOfUrl(origin);
  if (!domain) {
    return errorResult("The browser has no http(s) page open to fill credentials into. Navigate to the login page first.");
  }

  // ── which items even qualify? metadata only, before anyone is asked ─────
  const listed = await deps.secrets.listLoginCandidates(origin);
  if (!listed.ok) return errorResult(listed.error);
  if (listed.candidates.length === 0) {
    return errorResult(`No 1Password Login item matches ${origin}. The human can add the site to an item's website field and retry.`);
  }
  const candidates = reorderByHint(listed.candidates, args.item);

  // ── which identity is this PAGE in? ────────────────────────────────────
  const wants: SecretFieldWant[] = args.fields.map((field) => ({ kind: field.kind, ...(field.label ? { label: field.label } : {}) }));
  /**
   * The tab's own profile decides everything about a remembered authorization.
   * `deps.profile()` is consulted only to LABEL it for the card, and only when
   * it agrees with the tab — a session whose default has moved on must not put
   * another identity's name on this decision.
   */
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

  /**
   * WHICH AUTHORIZATION, IF ANY, COVERS THIS EXACT FILL.
   *
   * Every grant for this profile, this exact origin and these field kinds is
   * collected, then intersected with the DOMAIN-MATCHED candidates — so a grant
   * can never reach an item the ordinary path would not have offered, and a
   * grant whose item is gone is simply not a grant.
   *
   * WHAT IS DELIBERATELY NOT DONE: picking one. A person with two authorized
   * accounts on the same site is the case this whole feature exists for, and
   * quietly taking the first would be the exact failure. So: an explicit,
   * UNAMBIGUOUS `item` selects; one authorized candidate and no selection is
   * unambiguous by itself; anything else asks a human, with every candidate on
   * the card.
   */
  const authorized = profile && deps.grants ? deps.grants.findAll({ profileId: profile.id, origin, wants }) : [];
  const authorizedCandidates = candidates.filter((candidate) => authorized.some((grant) => grant.itemId === candidate.id));
  const selected = args.item ? resolveExactItem(candidates, args.item) : undefined;

  let chosen: SecretCandidate;
  /** The grant ACTUALLY SPENT on this fill — null on the human path, and never
   *  set from a lookup that did not decide the item. */
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
    // ── the human decides — never a mode, never a default ─────────────────
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
    // Remembering needs an identity to scope to; without one there is nothing a
    // later fill could match against, so the tick is simply not honoured.
    rememberThis = outcome.remember === true && Boolean(profile) && Boolean(deps.grants);
  }

  /**
   * WHEN AN EXACT ORIGIN IS THE PROMISE, IT IS ENFORCED FROM HERE ON.
   *
   * A human's ordinary approval is for a page, and stays bound to its
   * registrable domain — a login that redirects within its own site is the
   * common case and must keep working. But two situations are promises about
   * ONE EXACT ORIGIN and are held to it:
   *
   *   - a remembered authorization being SPENT (`usedGrant`), which was granted
   *     for that origin and nothing else;
   *   - a remembered authorization being CREATED (`rememberThis`). The card the
   *     person ticked named an exact origin. If the page moves — even within
   *     the same domain — the fill that would create it is no longer happening
   *     where they were told it would, so it is refused rather than quietly
   *     writing a standing permission for an address they never saw.
   */
  const exactOriginRequired = Boolean(usedGrant) || rememberThis;

  /**
   * CHECK ONE, before the vault is opened: is this still the same page, in the
   * same identity, at the same tab? Cheap, and it means a navigation during the
   * approval costs no vault read at all.
   */
  const beforeRead = await confirmTarget(deps.callBrowser, target, { originMustMatchExactly: exactOriginRequired });
  if (beforeRead) return errorResult(beforeRead);
  if (usedGrant && !stillAuthorizes(deps, usedGrant, wants)) {
    return errorResult("That remembered login was revoked — credentials were not filled.");
  }

  // ── vault read; values live in these locals and nowhere else ────────────
  // 1Password's OWN gate is untouched by any of the above: a locked vault, a
  // Touch ID prompt or a missing service-account token fails here, remembered
  // authorization or not.
  const read = await deps.secrets.readItemFields(chosen.id, wants);
  if (!read.ok) return errorResult(read.error);
  const values = read.values.map((entry) => entry.value);

  /**
   * CHECK TWO, AND THIS IS THE ONE THAT MATTERS: the vault read is an await of
   * unbounded length — it can sit on a Touch ID prompt for as long as a person
   * takes. Everything checked above may have changed while it waited, and the
   * next statement puts real credentials on a page. So the same checks run
   * again here, with values in hand and nothing sent yet, and a failure drops
   * them unused.
   */
  const beforeDispatch = await confirmTarget(deps.callBrowser, target, { originMustMatchExactly: exactOriginRequired });
  if (beforeDispatch) return errorResult(beforeDispatch);
  if (usedGrant && !stillAuthorizes(deps, usedGrant, wants)) {
    return errorResult("That remembered login was revoked — credentials were not filled.");
  }

  const fill = asToolResult(await deps.callBrowser("browser_fill_form", {
    // ADDRESSED, not implicit: the tab just verified is the tab written to.
    // (The headless runtime has one tab notion and drops this parameter.)
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
    // Playwright MCP error prose can echo the value it failed to fill.
    return errorResult(`Filling the form failed: ${scrubSecrets(textOf(fill), values)}`);
  }

  let submitted = false;
  if (args.submit) {
    // The submit is part of the same authorized act — it posts the credential
    // that was just typed — so it is checked and addressed exactly like the
    // fill. A page that moved between the two must not be submitted into.
    const beforeSubmit = await confirmTarget(deps.callBrowser, target, { originMustMatchExactly: exactOriginRequired });
    if (beforeSubmit) {
      return errorResult(`Filled ${describeFields(args.fields)} from “${chosen.title}” on ${origin}, but did not submit: ${beforeSubmit}`);
    }
    // And the authorization must still exist for the submit as well: pressing
    // the button is what actually spends the credential, and a revoke that
    // landed while the form was being filled has to stop it here too.
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

  /**
   * THE GRANT IS WRITTEN AFTER THE FILL WORKED, not when the box was ticked: an
   * approval whose fill failed authorizes nothing to repeat. It records exactly
   * what just happened — this profile, this origin, this item, these kinds.
   */
  if (rememberThis && profile && deps.grants) {
    /**
     * STORED FOR THE ORIGIN THE PERSON WAS SHOWN, AND ONLY IF NOTHING MOVED.
     *
     * The card named `origin` — this exact address, in this exact profile — and
     * that string, unmodified, is what gets written. It is deliberately NOT
     * re-read from the page here: reading it back would mean a navigation
     * during the fill could silently widen the authorization to an address
     * nobody agreed to, which is the failure this whole path exists to prevent.
     *
     * The confirmations above already ran with `originMustMatchExactly` (see
     * `exactOriginRequired`), so reaching this line means the fill happened on
     * that exact origin. This last read is the belt: same tab, same identity,
     * same origin, one more time, after the values went out — and if anything
     * differs the fill stands but no standing permission is created.
     */
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
        // A grant that could not be stored costs the person one more approval
        // later; it must never cost them the fill that already succeeded.
      }
    } else {
      rememberThis = false;
    }
  }
  if (usedGrant) {
    try { deps.grants?.touch(usedGrant.id); } catch { /* the same reasoning */ }
  }

  // Built fresh — the transport's own result is dropped unread.
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

/**
 * Is this grant still on the books, right now? Re-read (the store caches
 * nothing) so a revoke from the settings page during either await denies the
 * fill rather than being noticed a call too late.
 */
function stillAuthorizes(deps: SecretFillDeps, grant: LoginGrant, wants: readonly SecretFieldWant[]): boolean {
  return Boolean(deps.grants?.find({ profileId: grant.profileId, origin: grant.origin, itemId: grant.itemId, wants }));
}

/**
 * The ONE item an `item` argument names, or undefined when it names none or
 * more than one.
 *
 * EXACT MEANS EXACT on this path. The hint may be a vault item id, or a title
 * that matches exactly one candidate outright — a substring match ("google")
 * across two Google accounts is precisely the ambiguity that must reach a
 * person, so it resolves to nothing and the card is shown. (`reorderByHint`
 * still uses the loose match to put the likely one first ON that card, where a
 * human is looking at it.)
 */
function resolveExactItem(candidates: readonly SecretCandidate[], hint: string): SecretCandidate | undefined {
  const needle = hint.trim().toLowerCase();
  if (!needle) return undefined;
  const byId = candidates.find((candidate) => candidate.id === hint.trim());
  if (byId) return byId;
  const byTitle = candidates.filter((candidate) => candidate.title.trim().toLowerCase() === needle);
  return byTitle.length === 1 ? byTitle[0] : undefined;
}

/** A hint can only REORDER the domain-matched candidates — never add one. */
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
