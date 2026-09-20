/**
 * WHAT DEEPGRAM ACTUALLY SAYS WHEN IT REFUSES THE LISTEN SOCKET (#707).
 *
 * A browser's `WebSocket` error event carries no reason — deliberately, because
 * it would be a cross-origin oracle — so `use-dictation.ts` can only ever say
 * "the connection to the transcription service failed". Deepgram DOES send a
 * reason: it refuses the upgrade with an ordinary HTTP status and a JSON body,
 * and the browser throws both away. This opens the same socket by hand, over a
 * raw TLS connection, and prints that status and that body.
 *
 * IT BISECTS IN ONE RUN. Every variant below is a separate handshake against the
 * real endpoint: no keyterms, one plain term, one term carrying the accents and
 * punctuation a real session title has, a growing prefix of the whole glossary,
 * and each language. One labelled line each.
 *
 * ── IT NEEDS A KEY, AND IT NEVER PRINTS ONE ────────────────────────────────
 * The key is read from `DEEPGRAM_API_KEY` — an environment variable this script
 * is TOLD, never a credentials file it goes looking for, so running it cannot
 * quietly spend a key somebody did not mean to spend. It goes into one
 * `Authorization` header on the wire and nowhere else: not into the query, not
 * into the output, not into an error path (the transport's own error is
 * swallowed rather than echoed, for that reason alone). THE URL IS NEVER
 * PRINTED EITHER, on the principle that a URL is the thing a credential leaks
 * into — only the request line's LENGTH, which is what the second limit below
 * is about.
 *
 * Nothing it writes is safe to assume; nothing it writes is unsafe to paste.
 *
 *   DEEPGRAM_API_KEY=... bun scripts/probe-deepgram-listen.ts
 */
import { deepgramKeyterms } from "../apps/engine/src/dictation/keyterms";

const HOST = "api.deepgram.com";
const PATH = "/v1/listen";

const key = process.env.DEEPGRAM_API_KEY?.trim();
if (!key) {
  console.error("Set DEEPGRAM_API_KEY in the environment. It is never printed.");
  process.exit(2);
}

/**
 * THE GLOSSARY THIS MAC WOULD SEND, built by the engine's own builder against a
 * fixture that mirrors what the rail currently lists — so the probe runs against
 * a realistic list without reading the live store.
 */
const GLOSSARY = deepgramKeyterms({
  vocabulary: [],
  context: {
    sessionTitles: [
      "Telar",
      "BUG: el dictado falla el 100% de las veces en el cockpit",
      "#671 · Worktree listing + reclaim",
      "#248 · iOS Dynamic Type",
      "Coordinador · batch 2 (#49 — Issues, PRs y Diff)",
      "#691 · Las tarjetas deben pintar (§4)",
      "#690 · Diff miente en sesiones local (§3a)",
      "#692 · El hilo de issue/PR no se lee (§1b)",
      "Coordinador · batch 1 (issues viejos)",
      "Triage · PR #478 red + iOS nightly red",
      "iOS tests in CI · device job",
      "Agent lab: comparar #529 vs #530 y decidir rumbo (#528)",
      "Contexto sobre almacenamiento externo",
      "#974 revisión: Creatio sin ruta OData + pgTAP con datos reales",
      "NuSkills Revamp · arreglos WhatsApp 18 sep",
    ],
    projectNames: [
      "Telar",
      "Probe",
      "lintel",
      "Telar settings",
      "NuSkills-Coach-v2",
      "linger-prod-test",
      "orchestrator",
      "Telar Integrated",
      "Telar-work-surface",
      "ozom-gv",
      "linear-regression-from-scratch",
      "story",
      "advanced-AI",
      "facundo",
      "telar-vr",
    ],
    branches: [
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
    ],
  },
});

/** The same query `listenUrl` builds, minus the credential (which is a header). */
function query(input: { language: string; keyterms: readonly string[]; model?: string }): URLSearchParams {
  const parameters = new URLSearchParams();
  parameters.set("model", input.model ?? "nova-3");
  parameters.set("interim_results", "true");
  parameters.set("smart_format", "true");
  parameters.set("language", input.language);
  parameters.set("endpointing", "300");
  for (const term of input.keyterms) parameters.append("keyterm", term);
  return parameters;
}

/** One handshake. Returns the status line and the body Deepgram sends with a
 *  refusal — which is the whole point, and the thing a browser discards. */
async function handshake(parameters: URLSearchParams): Promise<{ status: string; body: string; bytes: number }> {
  const target = `${PATH}?${parameters.toString()}`;
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
  const request = [
    `GET ${target} HTTP/1.1`,
    `Host: ${HOST}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${nonce}`,
    "Sec-WebSocket-Version: 13",
    `Authorization: Token ${key}`,
    "",
    "",
  ].join("\r\n");

  let received = "";
  const done = Promise.withResolvers<void>();
  const settle = setTimeout(() => done.resolve(), 10_000);

  let socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
  try {
    socket = await Bun.connect({
      hostname: HOST,
      port: 443,
      tls: true,
      socket: {
        open: (s) => void s.write(request),
        data: (_s, chunk) => {
          received += new TextDecoder().decode(chunk);
          if (received.includes("\r\n\r\n")) setTimeout(() => done.resolve(), 200);
        },
        close: () => done.resolve(),
        // NO CAUSE IS PRINTED HERE. A transport error message is not a place a
        // credential ends up, but this script's rule is that nothing from the
        // request side is ever echoed.
        error: () => done.resolve(),
      },
    });
    await done.promise;
  } finally {
    clearTimeout(settle);
    try {
      socket?.end();
    } catch {
      // Already closed.
    }
  }

  const [head = "", ...rest] = received.split("\r\n\r\n");
  return {
    status: head.split("\r\n")[0]?.replace("HTTP/1.1 ", "").trim() || "(no answer)",
    body: rest.join("\r\n\r\n").trim(),
    bytes: `GET ${target} HTTP/1.1`.length,
  };
}

/** One labelled line. Never the URL — see the header. */
async function run(label: string, input: { language: string; keyterms: readonly string[]; model?: string }): Promise<void> {
  const parameters = query(input);
  const { status, body, bytes } = await handshake(parameters);
  const chars = input.keyterms.reduce((n, t) => n + t.length, 0);
  const shape = `${input.keyterms.length} terms / ${chars} chars / ${bytes}B request line`;
  const verdict = status.startsWith("101") ? "OPENS" : status;
  let said = "";
  if (body) {
    try {
      const parsed = JSON.parse(body) as { err_code?: string; err_msg?: string };
      said = parsed.err_msg ? ` — ${parsed.err_code ?? "?"}: ${parsed.err_msg}` : ` — ${body.slice(0, 200)}`;
    } catch {
      said = ` — ${body.slice(0, 200)}`;
    }
  }
  console.log(`${verdict.padEnd(26)} ${label.padEnd(44)} [${shape}]${said}`);
}

const ACCENTED = "#974 revisión: Creatio sin ruta OData + pgTAP con datos reales";
const SECTIONED = "#691 · Las tarjetas deben pintar (§4)";

const glossaryChars = GLOSSARY.reduce((n, t) => n + t.length, 0);
const glossaryBytes = GLOSSARY.reduce((n, t) => n + new TextEncoder().encode(t).length, 0);
console.log(`glossary the engine builds for this store: ${GLOSSARY.length} terms, ${glossaryChars} characters, ${glossaryBytes} bytes`);
// BYTES ARE THE UNIT THE BOUND IS IN (#707), and the one worth watching here:
// a token never covers fewer than one byte, so this is the ceiling on what
// Deepgram will count against its budget of 500. The characters are printed
// beside it only because the estimate that broke this counted those.
console.log(`(the bound charges ${glossaryBytes} of a 500-token budget; the estimate this replaced called it ${Math.ceil(glossaryChars / 4)})\n`);

// ── DOES IT OPEN AT ALL, PER LANGUAGE, WITH NO GLOSSARY ─────────────────────
for (const language of ["multi", "es", "en"]) await run(`no keyterms · language=${language}`, { language, keyterms: [] });

// ── IS THE MODEL NAME STILL GOOD ────────────────────────────────────────────
await run("no keyterms · model=nova-2 · language=multi", { language: "multi", keyterms: [], model: "nova-2" });
await run("no keyterms · model=nonsense · language=multi", { language: "multi", keyterms: [], model: "nova-3-does-not-exist" });

console.log("");

// ── ONE TERM, THREE SHAPES, EACH LANGUAGE ───────────────────────────────────
for (const language of ["multi", "es", "en"]) {
  await run(`1 plain ASCII keyterm · language=${language}`, { language, keyterms: ["Telar"] });
  await run(`1 accented keyterm · language=${language}`, { language, keyterms: [ACCENTED] });
  await run(`1 § · — keyterm · language=${language}`, { language, keyterms: [SECTIONED] });
}

console.log("");

// ── A GROWING PREFIX OF THE REAL GLOSSARY, WHICH IS WHERE A LIMIT SHOWS ──────
for (const take of [5, 10, 20, 30, 40, GLOSSARY.length]) {
  await run(`first ${take} of the real glossary · language=multi`, { language: "multi", keyterms: GLOSSARY.slice(0, take) });
}

console.log("");

// ── THE WHOLE GLOSSARY, EACH LANGUAGE ───────────────────────────────────────
for (const language of ["es", "en"]) await run(`the whole glossary · language=${language}`, { language, keyterms: GLOSSARY });

// ── AND A DELIBERATELY OVERSIZED ONE, so a limit that exists is seen to exist
// rather than inferred from its absence.
const OVERSIZED = Array.from({ length: 12 }, (_, i) => GLOSSARY.map((t) => `${t} ${i}`)).flat();
await run("deliberately oversized glossary · multi", { language: "multi", keyterms: OVERSIZED });
