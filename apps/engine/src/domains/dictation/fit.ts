import { DEEPGRAM_LISTEN_URL, askListen } from "./listen";
import { DEEPGRAM_KEYTERM_PROVABLE_BYTES, keytermBytes } from "./keyterms";

// Only Deepgram's sentence earns a retry: its edge also answers 400 (plain HTML) for an
// oversized request line, and retrying that can never succeed.
const KEYTERM_LIMIT = /keyterm limit exceeded/i;

const FIT_DEADLINE_MS = 2_500;
const REMEMBERED = 8;

function keytermPrefix(terms: readonly string[], budgetBytes: number): string[] {
  const kept: string[] = [];
  let spent = 0;
  for (const term of terms) {
    const cost = keytermBytes([term]);
    if (spent + cost > budgetBytes) break;
    kept.push(term);
    spent += cost;
  }
  return kept;
}

export type KeytermFit = {
  built: number;
  sent: number;
  reason?: "refused" | "unconfirmed";
};

let last: KeytermFit | undefined;

export function lastKeytermFit(): KeytermFit | undefined {
  return last;
}

const remembered = new Map<string, string[]>();

export function forgetKeytermFits(): void {
  remembered.clear();
  last = undefined;
}

// Newline-joined: `deepgramKeyterms` collapses whitespace, so no term contains one.
function rememberedKey(language: string, terms: readonly string[]): string {
  return [language, ...terms].join("\n");
}

function record(built: number, sent: number, reason: KeytermFit["reason"]): KeytermFit {
  last = { built, sent, ...(sent < built && reason ? { reason } : {}) };
  return last;
}

type Answer = "accepted" | "over-budget" | "unknown";

async function ask(input: Parameters<typeof askListen>[0]): Promise<Answer> {
  const answer = await askListen(input);
  if (answer.accepted) return "accepted";
  if (answer.status === 400 && KEYTERM_LIMIT.test(answer.body)) return "over-budget";
  return "unknown";
}

// Never throws and never returns more than it was given: every failure ends at the provable
// prefix. At most two asks (the built list, then one shrink) under one deadline.
export async function fitDeepgramKeyterms(input: {
  key: string | undefined;
  language: string;
  keyterms: readonly string[];
  fetchImpl?: typeof fetch;
  url?: string;
}): Promise<string[]> {
  const built = input.keyterms.length;
  const floor = (): string[] => keytermPrefix(input.keyterms, DEEPGRAM_KEYTERM_PROVABLE_BYTES);

  if (built === 0 || keytermBytes(input.keyterms) <= DEEPGRAM_KEYTERM_PROVABLE_BYTES) {
    record(built, built, undefined);
    return [...input.keyterms];
  }

  const key = input.key?.trim();
  if (!key) {
    record(built, floor().length, "unconfirmed");
    return floor();
  }

  const url = input.url ?? DEEPGRAM_LISTEN_URL;
  const fetchImpl = input.fetchImpl ?? fetch;
  const cached = remembered.get(rememberedKey(input.language, input.keyterms));
  if (cached) {
    record(built, cached.length, cached.length < built ? "refused" : undefined);
    return [...cached];
  }

  const deadline = AbortSignal.timeout(FIT_DEADLINE_MS);
  const ladder: string[][] = [[...input.keyterms]];
  const shrunk = keytermPrefix(input.keyterms, Math.floor((keytermBytes(input.keyterms) + DEEPGRAM_KEYTERM_PROVABLE_BYTES) / 2));
  if (shrunk.length > 0 && shrunk.length < built) ladder.push(shrunk);

  for (const candidate of ladder) {
    const answer = await ask({ key, language: input.language, keyterms: candidate, fetchImpl, url, signal: deadline });
    if (answer === "accepted") {
      if (remembered.size >= REMEMBERED) remembered.delete(remembered.keys().next().value as string);
      remembered.set(rememberedKey(input.language, input.keyterms), candidate);
      record(built, candidate.length, "refused");
      return candidate;
    }
    if (answer === "unknown") break;
  }

  record(built, floor().length, "unconfirmed");
  return floor();
}
