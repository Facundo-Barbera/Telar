/**
 * WHERE DEEPGRAM'S KEYTERM BOUNDARY ACTUALLY IS, PER CONTENT SHAPE (#712).
 *
 * `probe-deepgram-listen` answered the #707 question — what does Deepgram SAY
 * when it refuses. This answers the next one: at what SIZE does it start, and
 * how far does that size move when the words change.
 *
 * ── WHY THE ANSWER CANNOT BE REASONED TO ───────────────────────────────────
 * The budget is "500 tokens across all keyterms" and nobody outside Deepgram
 * has nova-3's tokenizer. #707's bug was an estimate of four characters to a
 * token; its fix was a byte ceiling, which is PROVABLE (a subword token never
 * covers fewer than one byte) and therefore conservative by exactly the amount
 * real text is more than one byte per token. The only way to learn that amount
 * is to walk a glossary up until the endpoint says no.
 *
 * ── IT BISECTS, PER SHAPE, AND THE SHAPE IS THE POINT ──────────────────────
 * Three glossaries, all built the way the engine builds one:
 *
 *   spanish   accents, `·`, `§`, `—`, `#` — the worst tokenizer here, and what
 *             this Mac's rail is actually full of;
 *   mixed     the real fixture: Spanish titles, project names, branch slugs;
 *   slug      `telar/...-a1b2c3` branch slugs, ASCII — the best tokenizer.
 *
 * For each, a binary search over the largest PREFIX that still upgrades. A
 * prefix rather than a subset because that is how the engine's own bound cuts
 * (from the tail), so the measurement and the mechanism are the same shape.
 *
 * THE NUMBER THAT MATTERS IS BYTES PER TOKEN AT THE EDGE. At the boundary the
 * glossary is spending ~500 tokens, so the bytes it weighs there divided by 500
 * is how many bytes that content buys per token. The SMALLEST of those across
 * shapes is what any byte-denominated bound has to survive.
 *
 * ── AND TWO QUESTIONS THE FIX'S DESIGN RESTS ON ────────────────────────────
 *   1. can a plain HTTPS GET — no `Upgrade` header — read the same refusal?
 *      If yes, an engine can check a glossary with `fetch` and an injected one
 *      is testable; if no, it needs a hand-written upgrade.
 *   2. is a `400` that is NOT the keyterm limit distinguishable from one that
 *      is? The edge's oversized-request-line refusal is the case that must
 *      never be retried.
 *
 * ── IT NEEDS A KEY, AND IT NEVER PRINTS ONE ────────────────────────────────
 * See `deepgram-handshake.ts`, which owns that rule for both probes.
 *
 *   DEEPGRAM_API_KEY=... bun scripts/probe-deepgram-keyterm-bound.ts
 */
import { deepgramKeyterms, type DictationContext } from "../apps/engine/src/dictation/keyterms";
import { handshake, listenQuery, requireKey, said } from "./deepgram-handshake";

const key = requireKey();

/** Deepgram's documented budget, and the divisor that turns a measured byte
 *  boundary into bytes-per-token for that content. */
const TOKEN_BUDGET = 500;

/** NO BOUND WHILE MEASURING. The engine's builder is used for the ordering,
 *  the dedup and the collapsing — everything except the ceiling, which is the
 *  thing being measured and cannot also be an input to it. */
const UNBOUNDED = 1_000_000;

const encoder = new TextEncoder();
const byteLength = (terms: readonly string[]): number => terms.reduce((n, t) => n + encoder.encode(t).length, 0);
const charLength = (terms: readonly string[]): number => terms.reduce((n, t) => n + t.length, 0);

/** Deepgram's refusal for this limit, verbatim from #707. Matched on the
 *  MESSAGE and not the status, which is the whole rule under test. */
const KEYTERM_LIMIT = /keyterm limit exceeded/i;

// ── THE THREE SHAPES ────────────────────────────────────────────────────────
// Long enough to overshoot the limit by a wide margin in every case, and built
// out of the kinds of string the store actually holds rather than filler: the
// question is how REAL words tokenize, and `xxxxxxxx` tokenizes like nothing
// anybody titles a conversation with.

const SPANISH_TITLES = [
  "BUG: el dictado falla el 100% de las veces en el cockpit",
  "#691 · Las tarjetas deben pintar (§4)",
  "#690 · Diff miente en sesiones local (§3a)",
  "#692 · El hilo de issue/PR no se lee (§1b)",
  "Coordinador · batch 2 (#49 — Issues, PRs y Diff)",
  "#974 revisión: Creatio sin ruta OData + pgTAP con datos reales",
  "NuSkills Revamp · arreglos WhatsApp 18 sep",
  "Revisión de diseño · tipografía y espaciado (§2)",
  "Migración del almacén externo — fase 1",
  "Análisis de sesión: por qué el índice está vacío",
  "Configuración de notificaciones — iOS y macOS",
  "Rediseño del diff sobre @pierre/diffs (§5)",
];

const SLUGS = [
  "telar/bug-el-dictado-falla-el-100-de-las-veces-439842",
  "telar/671-worktree-listing-reclaim-e53605",
  "telar/248-ios-dynamic-type-98bea8",
  "telar/691-las-tarjetas-deben-pintar-4-e7fee9",
  "telar/690-diff-miente-en-sesiones-local-3a-89157c",
  "telar/692-el-hilo-de-issue-pr-no-se-lee-1b-7a1ae9",
  "telar/triage-pr-478-red-ios-nightly-red-1bc2c4",
  "telar/ios-tests-in-ci-device-job-744085",
  "telar/agent-lab-comparar-529-vs-530-y-decidir--139ed0",
  "telar/974-revision-creatio-sin-ruta-odata-pgta-f7bd33",
];

const PROJECTS = [
  "Telar",
  "lintel",
  "NuSkills-Coach-v2",
  "linger-prod-test",
  "orchestrator",
  "Telar Integrated",
  "ozom-gv",
  "linear-regression-from-scratch",
  "advanced-AI",
  "telar-vr",
];

/** Enough of a list to overshoot, without repeating a term (the builder would
 *  dedupe it away). Numbering is how a real rail looks anyway — issue numbers
 *  are what titles carry. */
const grow = (source: readonly string[], count: number): string[] =>
  Array.from({ length: count }, (_, index) => {
    const base = source[index % source.length] as string;
    const round = Math.floor(index / source.length);
    return round === 0 ? base : `#${600 + index} ${base}`;
  });

const empty: DictationContext = { sessionTitles: [], projectNames: [], branches: [] };

/** The three candidate lists, each already ordered and deduplicated by the
 *  engine's own builder — only the ceiling is removed. */
const SHAPES: { name: string; terms: string[] }[] = [
  {
    name: "spanish",
    terms: deepgramKeyterms({
      vocabulary: [],
      context: { ...empty, sessionTitles: grow(SPANISH_TITLES, 140) },
      budgetBytes: UNBOUNDED,
    }),
  },
  {
    name: "mixed",
    terms: deepgramKeyterms({
      vocabulary: [],
      context: {
        sessionTitles: grow(SPANISH_TITLES, 60),
        projectNames: grow(PROJECTS, 40),
        branches: grow(SLUGS, 60),
      },
      budgetBytes: UNBOUNDED,
    }),
  },
  {
    name: "slug",
    terms: deepgramKeyterms({
      vocabulary: [],
      context: { ...empty, branches: grow(SLUGS, 140) },
      budgetBytes: UNBOUNDED,
    }),
  },
];

/** What one prefix did. `other` is anything that is neither an upgrade nor this
 *  limit — a rate limit, an edge refusal, a dropped connection — and it STOPS
 *  the search rather than being folded into "refused": bisecting against an
 *  answer that means something else is how a measurement quietly becomes a
 *  guess. */
type Verdict = "opens" | "keyterm-limit" | "other";

let calls = 0;

async function attempt(terms: readonly string[]): Promise<{ verdict: Verdict; status: string; body: string; requestLineBytes: number }> {
  calls += 1;
  const answer = await handshake(listenQuery({ language: "multi", keyterms: terms }), key);
  // A BREATH BETWEEN HANDSHAKES. A bisect is a burst of upgrades from one key,
  // and a rate limit landing mid-search would read as a boundary.
  await Bun.sleep(150);
  const verdict: Verdict = answer.status.startsWith("101")
    ? "opens"
    : answer.status.startsWith("400") && KEYTERM_LIMIT.test(answer.body)
      ? "keyterm-limit"
      : "other";
  return { verdict, ...answer };
}

/** The largest prefix that still upgrades, by binary search on term COUNT.
 *  Returns `undefined` if the search met an answer it cannot interpret. */
async function boundary(name: string, terms: readonly string[]): Promise<{ count: number; bytes: number } | undefined> {
  // THE TOP OF THE SEARCH IS FOUND, NOT ASSUMED. The fixtures are deliberately
  // enormous so the boundary is certainly inside them — which puts the whole
  // list past Deepgram's OTHER limit, the edge's request-line one, where the
  // answer is a plain-HTML 400 that says nothing about keyterms. So halve until
  // the refusal is the one being measured. Bisecting against the other limit
  // would report the edge's boundary under this one's name.
  let refused = terms.length;
  let top = await attempt(terms.slice(0, refused));
  while (top.verdict === "other" && refused > 1) {
    refused = Math.floor(refused / 2);
    top = await attempt(terms.slice(0, refused));
  }
  if (top.verdict === "opens") {
    console.log(
      `  ${name}: ${refused} terms / ${byteLength(terms.slice(0, refused))}B OPENS, and everything above it hit the edge's` +
        " request-line limit instead — this content reaches that limit before the keyterm one.",
    );
    return undefined;
  }
  if (top.verdict === "other") {
    console.log(`  ${name}: ABORTED — no prefix answered the keyterm limit; the smallest tried said ${top.status} ${said(top.body)}`);
    return undefined;
  }

  let open = 0;
  while (refused - open > 1) {
    const middle = Math.floor((open + refused) / 2);
    const slice = terms.slice(0, middle);
    const answer = await attempt(slice);
    if (answer.verdict === "other") {
      console.log(`  ${name}: ABORTED at ${middle} terms — ${answer.status} ${said(answer.body)}`);
      return undefined;
    }
    if (answer.verdict === "opens") open = middle;
    else refused = middle;
  }

  const accepted = terms.slice(0, open);
  const first = terms.slice(0, refused);
  const bytes = byteLength(accepted);
  console.log(
    `  ${name}: OPENS at ${open} terms / ${bytes}B / ${charLength(accepted)} chars` +
      `  ·  REFUSED at ${refused} terms / ${byteLength(first)}B` +
      `  ·  ${(bytes / TOKEN_BUDGET).toFixed(2)} bytes per token`,
  );
  return { count: open, bytes };
}

console.log(`Deepgram's keyterm boundary, measured. Budget as documented: ${TOKEN_BUDGET} tokens.\n`);
console.log("── THE BOUNDARY, PER CONTENT SHAPE ─────────────────────────────────────────");

const found: { name: string; bytes: number }[] = [];
for (const shape of SHAPES) {
  const edge = await boundary(shape.name, shape.terms);
  if (edge) found.push({ name: shape.name, bytes: edge.bytes });
}

if (found.length > 0) {
  const worst = found.reduce((a, b) => (a.bytes < b.bytes ? a : b));
  const best = found.reduce((a, b) => (a.bytes > b.bytes ? a : b));
  console.log(
    `\n  WORST SHAPE: ${worst.name} at ${worst.bytes}B (${(worst.bytes / TOKEN_BUDGET).toFixed(2)} B/token).` +
      ` BEST: ${best.name} at ${best.bytes}B (${(best.bytes / TOKEN_BUDGET).toFixed(2)} B/token).`,
  );
  console.log(`  ANY BYTE BOUND MUST SIT UNDER ${worst.bytes} — that is the one the content can reach.`);
}

// ── CAN A PLAIN GET READ THE REFUSAL? ───────────────────────────────────────
// If it can, checking a glossary is a `fetch` an engine can inject a fake for.
// If it cannot, the check needs a hand-written upgrade to see the same answer.
console.log("\n── DOES A NON-UPGRADE GET SEE THE SAME REFUSAL? ────────────────────────────");
{
  const over = SHAPES[0]?.terms ?? [];
  for (const [label, terms] of [
    ["over the limit", over],
    ["inside the limit", over.slice(0, 5)],
  ] as const) {
    const parameters = listenQuery({ language: "multi", keyterms: terms });
    try {
      const response = await fetch(`https://api.deepgram.com/v1/listen?${parameters.toString()}`, {
        headers: { Authorization: `Token ${key}` },
      });
      const body = (await response.text()).trim();
      console.log(`  plain GET, ${label.padEnd(16)} → ${response.status} ${said(body) || "(no body)"}`);
    } catch {
      // NO CAUSE PRINTED. A transport error is not a place a credential ends
      // up, but this file's rule is that nothing request-side is ever echoed.
      console.log(`  plain GET, ${label.padEnd(16)} → the request failed before an answer`);
    }
  }
}

// ── AND A 400 THAT IS NOT THIS ONE ──────────────────────────────────────────
// The rule the fix needs is "match the message, not the status", and a rule
// needs the case it is there to exclude.
console.log("\n── A 400 THAT MEANS SOMETHING ELSE ─────────────────────────────────────────");
{
  const enormous = Array.from({ length: 900 }, (_, index) => `termino-numero-${index}-de-prueba-larga`);
  const answer = await handshake(listenQuery({ language: "multi", keyterms: enormous }), key);
  const matches = KEYTERM_LIMIT.test(answer.body);
  console.log(
    `  oversized request line (${answer.requestLineBytes}B) → ${answer.status} — ${said(answer.body) || "(no body)"}`,
  );
  console.log(`  does it match /keyterm limit exceeded/i? ${matches ? "YES — the rule would retry it" : "NO — the rule excludes it"}`);
}

console.log(`\n${calls + 3} handshakes.`);
