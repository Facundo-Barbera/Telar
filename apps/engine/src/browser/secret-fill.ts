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
 * DOMAIN BINDING IS READ FROM THE BROWSER, TWICE. The origin comes from the
 * engine's own tab state (the model cannot claim a different page), candidates
 * are filtered to items whose website matches it by registrable domain, and
 * the origin is re-read after the human approves — an approval is for a page,
 * not a token the tab can spend somewhere else after navigating.
 */
import type { SecretAccessDetail, SecretCandidate } from "@telar/engine-client";
import { parseBrowserTabs, textOf } from "./helpers";
import { registrableDomainOfUrl, type SecretFieldWant, type SecretsProvider } from "../secrets/onepassword";
import { BrowserToolInputError, BrowserToolResult, parseBrowserToolInput } from "./tools";

export type SecretAskOutcome = {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
  /** The human's item pick — `answers.item` of the resolved request. */
  itemId?: string;
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

/** The active tab's URL, from the engine's own tab state. */
async function activeTabUrl(callBrowser: SecretFillDeps["callBrowser"]): Promise<string | null> {
  const result = asToolResult(await callBrowser("browser_list_tabs", {}));
  if (result.isError) return null;
  const tabs = parseBrowserTabs(textOf(result));
  const tab = tabs.find((candidate) => candidate.active) ?? tabs[0];
  return tab && tab.url !== "about:blank" ? tab.url : null;
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

  // ── where does this fill land? ──────────────────────────────────────────
  const url = await activeTabUrl(deps.callBrowser);
  const origin = url ? originOf(url) : null;
  const domain = origin ? registrableDomainOfUrl(origin) : null;
  if (!origin || !domain) {
    return errorResult("The browser has no http(s) page open to fill credentials into. Navigate to the login page first.");
  }

  // ── which items even qualify? metadata only, before anyone is asked ─────
  const listed = await deps.secrets.listLoginCandidates(origin);
  if (!listed.ok) return errorResult(listed.error);
  if (listed.candidates.length === 0) {
    return errorResult(`No 1Password Login item matches ${origin}. The human can add the site to an item's website field and retry.`);
  }
  const candidates = reorderByHint(listed.candidates, args.item);

  // ── the human decides — never a mode, never a default ───────────────────
  const outcome = await deps.ask({
    origin,
    fields: args.fields.map((field) => ({ kind: field.kind, ...(field.label ? { label: field.label } : {}) })),
    candidates,
    ...(args.item ? { hint: args.item } : {}),
  });
  if (outcome.decision !== "accept" && outcome.decision !== "acceptForSession") {
    return errorResult("The human declined to fill credentials from 1Password.");
  }
  const chosen = candidates.find((candidate) => candidate.id === outcome.itemId) ?? candidates[0]!;

  // ── the page must still be where the approval was given ────────────────
  const urlAfter = await activeTabUrl(deps.callBrowser);
  const domainAfter = urlAfter ? registrableDomainOfUrl(urlAfter) : null;
  if (domainAfter !== domain) {
    return errorResult("The page changed while waiting for approval — credentials were not filled.");
  }

  // ── vault read; values live in these locals and nowhere else ────────────
  const wants: SecretFieldWant[] = args.fields.map((field) => ({ kind: field.kind, ...(field.label ? { label: field.label } : {}) }));
  const read = await deps.secrets.readItemFields(chosen.id, wants);
  if (!read.ok) return errorResult(read.error);
  const values = read.values.map((entry) => entry.value);

  const fill = asToolResult(await deps.callBrowser("browser_fill_form", {
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
    const click = asToolResult(await deps.callBrowser("browser_click", {
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

  // Built fresh — the transport's own result is dropped unread.
  return {
    content: [
      {
        type: "text",
        text: `Filled ${describeFields(args.fields)} from “${chosen.title}” on ${origin}.${submitted ? " Submitted." : ""}`,
      },
    ],
  };
}

function describeFields(fields: readonly ParsedField[]): string {
  return fields.map((field) => (field.kind === "field" ? `“${field.label}”` : field.kind)).join(" and ");
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
