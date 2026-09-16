/**
 * THE ONE TEST THAT TOUCHES THE REAL SERVICE — off unless asked for (#526).
 *
 * SKIPPED UNLESS `TELAR_LIVE_SMOKE=1`, so it never runs in CI, never runs on a
 * contributor's machine by accident, and never spends anybody's credit as a
 * side effect of `bun test`. Everything else about this driver is tested
 * against a fake server that lives inside the test process; this exists to
 * answer the one question a fake cannot — does the real endpoint accept what
 * this build actually sends.
 *
 * ── IT RESOLVES THE KEY THE WAY THE DRIVER DOES, AND NO OTHER WAY ───────────
 * `resolveGoCredential` with the same three rungs, so what is proven is the
 * resolver AND the request together. If that finds nothing the test says which
 * rungs were empty and stops; it does not fall back to a key typed here, and it
 * does not go looking anywhere the driver would not.
 *
 * ── NOTHING IT PRINTS CAN CARRY A KEY ───────────────────────────────────────
 * Every line goes through `say`, which runs `redactKey` over it first. The
 * source is named by RUNG (`describeGoCredential`), which is the only thing
 * about a credential this codebase will say out loud.
 *
 * ── ONE CALL EACH ───────────────────────────────────────────────────────────
 * `GET /models` with no credential (the docs publish it as open), and ONE chat
 * completion with `max_tokens: 1`. No loop and no retry beyond a single backoff
 * on a 429 — a smoke test that retried would be a smoke test that could bill
 * somebody twice for a mistake.
 */
import { describe, expect, test } from "bun:test";
import { describeGoCredential, redactKey, resolveGoCredential } from "../src/agent/credentials";
import { DEFAULT_GO_MODEL, goHeaders, goModelIds, OPENCODE_GO_BASE } from "../src/agent/go";

const LIVE = process.env.TELAR_LIVE_SMOKE === "1";

/** The turn's own id, so the upstream sees one conversation for this smoke —
 *  the same header a real turn carries. */
const SMOKE_SESSION = "session_telar_live_smoke";

describe.skipIf(!LIVE)("OpenCode Go, live", () => {
  const credential = resolveGoCredential({});
  /** Print, with any key scrubbed first. The backstop is applied even to lines
   *  that could not contain one — a redaction with an exception is a redaction
   *  somebody will eventually route around. */
  const say = (line: string) => console.log(redactKey(line, credential?.key));

  test("the resolver finds a usable credential, or says which rungs were empty", () => {
    say(`[live] credential: ${describeGoCredential(credential)}`);
    // A FAILURE HERE IS THE REPORT, not a guess: the next two tests cannot say
    // anything about the service if there is nothing to call it with.
    expect(credential, "no key on any of the three rungs — paste one, export OPENCODE_API_KEY, or sign the OpenCode CLI in").toBeDefined();
  });

  test("GET /models answers, without a credential", async () => {
    const response = await fetch(`${OPENCODE_GO_BASE}/models`, { headers: goHeaders({}), signal: AbortSignal.timeout(15_000) });
    const ids = response.ok ? goModelIds(await response.json()) : [];
    say(`[live] GET /models → ${response.status}, ${ids.length} models, default ${DEFAULT_GO_MODEL} ${ids.includes(DEFAULT_GO_MODEL) ? "served" : "NOT in list"}`);
    expect(response.status).toBe(200);
    expect(ids.length).toBeGreaterThan(0);
  });

  test("one chat completion, one token", async () => {
    if (!credential) return;
    const body = {
      model: DEFAULT_GO_MODEL,
      // NOT STREAMED, deliberately: what this proves is that the headers, the
      // auth and the model id are accepted. The stream is covered by the fake,
      // frame by frame, including splits no real server would produce.
      stream: false,
      max_tokens: 1,
      messages: [{ role: "user", content: "hi" }],
    };
    const send = () =>
      fetch(`${OPENCODE_GO_BASE}/chat/completions`, {
        method: "POST",
        headers: goHeaders({ apiKey: credential.key, sessionId: SMOKE_SESSION, json: true }),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });

    let response = await send();
    // ONE backoff, and only for a rate limit. Anything else is reported as it
    // came rather than hammered at.
    if (response.status === 429) {
      say("[live] 429 — one backoff, then one retry");
      await Bun.sleep(5_000);
      response = await send();
    }

    const payload: unknown = await response.json().catch(() => undefined);
    const echoed = typeof payload === "object" && payload !== null ? (payload as { model?: unknown }).model : undefined;
    const usage = typeof payload === "object" && payload !== null ? (payload as { usage?: unknown }).usage : undefined;
    say(`[live] POST /chat/completions → ${response.status}, model echoed ${typeof echoed === "string" ? echoed : "(none)"}`);
    say(`[live] usage ${usage === undefined ? "(not reported)" : JSON.stringify(usage)}`);
    // The BODY is never printed: a completion is the model's words and this
    // test has no business putting them in a log.
    expect(response.status).toBe(200);
  });
});
