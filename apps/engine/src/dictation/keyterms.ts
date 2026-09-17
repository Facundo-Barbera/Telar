/**
 * THE WORDS THIS MAC IS ABOUT, HANDED TO THE RECOGNISER BEFORE IT LISTENS
 * (#581).
 *
 * ── THE BUG WAS THAT WE PRIMED IT WITH NOTHING ──────────────────────────────
 * The headset has been doing this since it shipped: `telar-vr` builds up to
 * forty deduplicated `keyterm=` parameters out of the session titles and
 * project names it can see, and puts them on every socket it opens. Telar's own
 * clients sent NONE — the web's `listenUrl` and the phone's `DeepgramListen.url`
 * set model, language, formatting and endpointing and stopped there. So the
 * owner's report is exactly what the wire says: the VR client "understands the
 * glossary much better", because it is the only surface that was ever told what
 * the glossary is.
 *
 * There is no fuzzy matching anywhere on our side and this does not add one.
 * "The glossary" IS Deepgram's keyterm prompting — a list of words the model
 * biases towards while decoding — and the whole fix is to send it.
 *
 * ── WHY THE LIST IS BUILT HERE AND NOT IN A CLIENT ──────────────────────────
 * The names come out of the STORE: which conversations are unsettled, what the
 * projects are called, which branches they cut. A browser tab and a phone have
 * none of that and would each need a second read to get it — so it rides the
 * token answer, which is the one round trip every press of the mic button
 * already makes. See `token.ts`, which carries `language` for the same reason.
 *
 * ── AND WHY IT IS THE PROVIDER'S FUNCTION ───────────────────────────────────
 * `keyterm` is Deepgram's word. Another provider primes with a `prompt` string,
 * or a biasing list with weights, or nothing at all. So the SETTING stores a
 * person's plain terms (`vocabulary`) and the engine hands a provider the raw
 * material; expressing it is the provider's job, which is `deepgramKeyterms`
 * here and would be a different function on the next one. Nothing outside this
 * directory learns the vendor's parameter name.
 *
 * ── THE BOUNDS, AND WHY BOTH OF THEM ────────────────────────────────────────
 * Deepgram documents a budget for keyterm prompting rather than a count, and the
 * headset settled on forty. Both are kept:
 *
 *   FORTY TERMS, because that is what has been working on the headset for
 *   months against the same model, and because a query string is a URL that has
 *   to survive every proxy on the path.
 *
 *   ~500 TOKENS, counted as four characters to a token — the ordinary
 *   approximation, and deliberately an approximation: the alternative is a
 *   tokenizer on the token-minting path for a cap whose exact edge changes
 *   nothing. Forty session titles can be two thousand characters on their own,
 *   so the count alone is not a bound.
 *
 * WHATEVER DOES NOT FIT IS DROPPED FROM THE TAIL rather than skipped over, so
 * the list is always a PREFIX of the order below. Skipping a long title to fit
 * two short ones after it would make "what got sent" depend on lengths nobody
 * can see.
 */

/** What this Mac is currently about, read off the store — see
 *  `EngineState.dictationContext`. Three lists rather than one so the ORDER
 *  below belongs to this file: the store answers what there is, and what
 *  survives a full budget is a decision about priming a recogniser. */
export type DictationContext = {
  /** Unsettled conversations, most recently touched first. */
  sessionTitles: readonly string[];
  /** Registered projects, as the rail names them. */
  projectNames: readonly string[];
  /** The branches those unsettled conversations cut, same order as their
   *  titles. */
  branches: readonly string[];
};

/** At most this many `keyterm=` parameters, which is what the headset sends. */
export const DEEPGRAM_KEYTERM_LIMIT = 40;

/** Deepgram's own budget for a keyterm prompt. */
export const DEEPGRAM_KEYTERM_TOKEN_BUDGET = 500;

/** The usual approximation, and the reason the budget above is a `~`. */
const CHARACTERS_PER_TOKEN = 4;

/**
 * A SENTENCE IS NOT A KEYTERM. A conversation can be titled with a whole clause,
 * and priming the model with one neither helps it hear the words nor leaves room
 * for the thirty terms behind it. Anything longer than this is dropped as the
 * wrong KIND of thing rather than for its size, which is why it is a filter
 * above the budget rather than part of it.
 */
const MAX_TERM_CHARACTERS = 80;

/**
 * THE APP'S OWN WORDS, WHICH NOTHING IN THE STORE WOULD EVER SUPPLY.
 *
 * "Telar" is the name the person says most and the one Deepgram has least chance
 * of guessing; the rest are the nouns this cockpit's vocabulary is actually made
 * of, and every one of them is a word the recogniser otherwise hears as
 * something else ("worktree" as "work tree", "PR" as "peer", "rail" as "real").
 *
 * SEVEN, AND THEY SIT SECOND. They come after the person's own terms and BEFORE
 * anything read off the store, which is a deliberate departure from listing them
 * last: they are a fixed, tiny, always-right set, and a Mac with forty unsettled
 * conversations would otherwise push the app's own name off the end of its own
 * vocabulary prompt — which is the bug in the issue's title, reintroduced by the
 * order it was fixed in.
 */
export const TELAR_KEYTERMS: readonly string[] = ["Telar", "Agent", "worktree", "nightly", "PR", "cockpit", "rail"];

/**
 * The `keyterm` values for one socket, in the order they go on the query.
 *
 * THE ORDER IS THE PRIORITY, because both bounds cut from the tail:
 *
 *   1. the person's own terms — they typed them into a box for this, and a list
 *      that dropped them in favour of a branch name would be ignoring the one
 *      part of it somebody asked for;
 *   2. the app's own words (above);
 *   3. unsettled session titles, most recently touched first — what is on
 *      screen is what somebody is about to talk about;
 *   4. project names;
 *   5. the branches those conversations cut. Last because a branch is a slug:
 *      `telar/dictation-keyterms-...-b781ea` is fifty characters of budget for a
 *      string nobody pronounces, and it is the first thing that should go.
 *
 * DEDUPLICATED CASE-INSENSITIVELY, first spelling wins. A project called
 * "Telar" and the constant "Telar" are one term; so are a branch and the title
 * it was cut from, which is the commonest collision here by far.
 */
export function deepgramKeyterms(input: { vocabulary: readonly string[]; context: DictationContext }): string[] {
  const budget = DEEPGRAM_KEYTERM_TOKEN_BUDGET * CHARACTERS_PER_TOKEN;
  const kept: string[] = [];
  const seen = new Set<string>();
  let spent = 0;

  for (const candidate of [
    ...input.vocabulary,
    ...TELAR_KEYTERMS,
    ...input.context.sessionTitles,
    ...input.context.projectNames,
    ...input.context.branches,
  ]) {
    // COLLAPSED, because a title carries whatever whitespace somebody typed and
    // a query parameter with a newline in it is a different argument about
    // encoding than the one this function is having.
    const term = candidate.replace(/\s+/g, " ").trim();
    if (!term || term.length > MAX_TERM_CHARACTERS) continue;
    const key = term.toLocaleLowerCase();
    if (seen.has(key)) continue;
    // BOTH BOUNDS STOP THE LIST rather than skipping this one entry — see the
    // header for why the answer is always a prefix.
    if (kept.length >= DEEPGRAM_KEYTERM_LIMIT || spent + term.length > budget) break;
    seen.add(key);
    kept.push(term);
    spent += term.length;
  }
  return kept;
}
