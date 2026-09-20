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
 * headset settled on forty. ONLY DEEPGRAM'S OWN BOUND IS KEPT (owner,
 * 2026-09-17): the count of forty was the headset's habit rather than a rule,
 * and the marginal cost of the sixty terms it was hiding is zero — keyterm
 * prompting is an add-on billed per minute DICTATED, not per term, so a longer
 * glossary costs exactly what a shorter one does. The owner accepted that
 * per-minute add-on explicitly. What remains is the budget Deepgram documents,
 * which is also the real bound: forty session titles can be two thousand
 * characters, so a count never was one.
 *
 * ── AND WHY THE BUDGET IS NOW COUNTED IN BYTES (#707) ───────────────────────
 * That budget used to be spent against an ESTIMATE — four characters to a
 * token, the ordinary approximation — and the estimate is what broke dictation
 * outright. Probed against the real endpoint, a glossary this builder called
 * 313 tokens was refused:
 *
 *   400 Bad Request — Keyterm limit exceeded. The maximum number of tokens
 *   across all keyterms is 500.
 *
 * Four characters to a token is an English figure. A Spanish session title
 * carrying `·`, `§`, `—` and `#` tokenizes closer to TWO, so the approximation
 * was wrong by more than half in the one direction that costs the whole
 * feature: the socket does not open at all, on every press, and the browser
 * cannot report why (see `use-dictation.ts`). Dropping a term is a degradation;
 * this was an outage.
 *
 * SO THE BUDGET IS SPENT IN UTF-8 BYTES, and the reason is that this is not an
 * estimate at all. A subword token never covers FEWER than one byte, so a
 * term's byte length is an upper bound on the tokens it can possibly cost — it
 * cannot be wrong in the direction that refuses the socket, for any input,
 * including emoji and scripts nobody here has thought about.
 *
 * ── AND WHY THE BOUND IS 700 AND NOT 500 (#712) ─────────────────────────────
 * One byte per token is the PATHOLOGICAL case, not the ordinary one, so #707's
 * ceiling gave up most of the budget: 470 bytes of this Mac's real glossary is
 * seventeen terms out of a list of forty-odd. How much it gave up was not
 * knowable by argument — nobody outside Deepgram has nova-3's tokenizer — so it
 * was MEASURED, by walking a glossary up against the live endpoint until it was
 * refused (`scripts/probe-deepgram-keyterm-bound.ts`, 2026-09-19):
 *
 *   slug content     `telar/690-diff-miente-en-sesiones-local-3a-89157c`
 *                    opens at 24 terms / 848 B, refused at 892 B  → 1.70 B/token
 *   spanish content  `#974 revisión: Creatio sin ruta OData + pgTAP…`
 *                    opens at 34 terms / 1414 B, refused at 1463 B → 2.83 B/token
 *
 * THE SPREAD IS THE FINDING, and it points the opposite way from the obvious
 * guess. ASCII does not tokenize better here: a branch slug is 52 plain bytes
 * and about thirty tokens, because every hyphen, digit and hex suffix takes
 * one, while the Spanish title it was cut from is 63 bytes and about
 * twenty-two. So "English is ~4 bytes per token" is not a safe premise for this
 * list, and a bound near 1000 would be comfortable for titles and REFUSED for a
 * glossary whose tail is branches.
 *
 * 700 sits 18% under the worst shape that could be built out of real material
 * and 40% above the provable floor. It is also not reachable by the worst shape
 * in practice: branches come from the same unsettled conversations as the
 * titles, and titles are ordered ahead of them below, so a real prefix always
 * leads with the better-tokenizing words. The one input that could be pure slug
 * is the person's own `vocabulary`, and 700 survives that too.
 *
 * ── THE FLOOR IS WHAT MAKES RAISING IT SAFE ─────────────────────────────────
 * 700 is measured rather than proved, and a measurement is about the words that
 * were measured. So it is not load-bearing: `fit.ts` asks Deepgram whether the
 * list it built is actually accepted, shrinks it when the answer is no, and
 * falls back to `DEEPGRAM_KEYTERM_PROVABLE_BYTES` — which cannot be refused for
 * any input — whenever it cannot get an answer at all. Being wrong about 700
 * costs a round trip and some terms. It cannot cost dictation.
 *
 * ── THERE ARE TWO LIMITS HERE, AND THIS ONE IS STILL THE TIGHTER ────────────
 * The second is the size of the request line itself: Deepgram's edge answers a
 * plain-HTML `400 Bad request` — before it even looks at the credential — once
 * the query grows past a few kilobytes. It is real, and it was the other
 * candidate for #707's bug. It is NOT what is respected here, because it does
 * not need to be: 700 bytes of keyterms makes a request line around a kilobyte,
 * and the edge was measured refusing at 38 KB. The margin narrowed when the
 * bound rose and it is still wide.
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

/** Deepgram's own budget for a keyterm prompt. Their words, quoted by the
 *  refusal itself: "The maximum number of tokens across all keyterms is 500." */
export const DEEPGRAM_KEYTERM_TOKEN_BUDGET = 500;

/**
 * THE LIST THAT CANNOT BE REFUSED, WHATEVER IS IN IT.
 *
 * Equal to the token budget, and equal for a reason rather than by coincidence:
 * a subword token never covers fewer than one byte, so N bytes can never cost
 * more than N tokens. A prefix this long is inside the budget for any input in
 * any script — which is what makes it the floor every failure in `fit.ts` ends
 * at, and why that floor is never asked about.
 */
export const DEEPGRAM_KEYTERM_PROVABLE_BYTES = DEEPGRAM_KEYTERM_TOKEN_BUDGET;

/**
 * WHAT THE LIST IS BUILT TO — measured, not proved, and safe to be because of
 * the floor above. See the header for the probe and the 1.70-vs-2.83 spread
 * that sets it here.
 */
export const DEEPGRAM_KEYTERM_BYTE_BUDGET = 700;

/** Reused rather than built per term — this runs on the token-minting path,
 *  which is a press of the mic button. */
const encoder = new TextEncoder();

/**
 * THE MOST TOKENS A TERM COULD POSSIBLY COST, which is its UTF-8 byte length.
 *
 * NOT AN ESTIMATE, which is the whole point — see the header. A subword token
 * never covers fewer than one byte, so this can only ever over-charge, and
 * over-charging costs a term while under-charging costs dictation.
 */
function tokenCeiling(term: string): number {
  return encoder.encode(term).length;
}

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
 * THE ORDER IS THE PRIORITY, because the budget cuts from the tail — and now
 * that the budget is charged in bytes it cuts deeper, so the order matters more
 * than it did:
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
export function deepgramKeyterms(input: {
  vocabulary: readonly string[];
  context: DictationContext;
  /** How many BYTES the list may weigh. Defaults to the measured bound above,
   *  and is a parameter for one reason: the probe that measures the real
   *  boundary has to build lists past it. */
  budgetBytes?: number;
}): string[] {
  const budget = input.budgetBytes ?? DEEPGRAM_KEYTERM_BYTE_BUDGET;
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
    // THE BUDGET STOPS THE LIST rather than skipping this one entry — see the
    // header for why the answer is always a prefix.
    const cost = tokenCeiling(term);
    if (spent + cost > budget) break;
    seen.add(key);
    kept.push(term);
    spent += cost;
  }
  return kept;
}
