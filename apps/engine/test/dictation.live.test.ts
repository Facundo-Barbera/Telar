/**
 * THE ONE DICTATION TEST THAT TOUCHES DEEPGRAM — off unless asked for (#544).
 *
 * SKIPPED UNLESS `TELAR_LIVE_SMOKE=1`, so it never runs in CI, never runs on a
 * contributor's machine by accident, and never spends anybody's credit as a
 * side effect of `bun test`. Everything else about dictation is tested against
 * an injected `fetch` in `dictation-token.test.ts`; this exists to answer the
 * one question a fake cannot — does the real grant endpoint accept what this
 * build actually sends.
 *
 * ── IT GOES THROUGH `grantDictationToken`, NOT AROUND IT ────────────────────
 * A smoke that built its own headers would prove the ENDPOINT and not the code
 * path, which is the mistake `agent.live.test.ts` records having made. The
 * header spelling (`Token`, not `Bearer`) and the body field (`ttl_seconds`,
 * not `ttl`) are exactly the things that drift when a vendor's docs change, so
 * the smoke drives the function a route drives.
 *
 * ── THE KEY IS THE ONE A ROUTE WOULD SPEND ──────────────────────────────────
 * `TELAR_HOME` names a real engine root when the machine has one, and rung one
 * is read out of it; `DEEPGRAM_API_KEY` in the environment is the fallback for
 * a machine that has not pasted one into Telar. Neither is invented here, and
 * nothing is written.
 *
 * ── ONE CALL, AND THAT IS THE BUDGET ────────────────────────────────────────
 * A single grant, at the shortest TTL the endpoint allows, because the token is
 * thrown away. No loop and no retry: a smoke that retried would be one that
 * could bill somebody twice for a mistake.
 *
 * ── NOTHING IT PRINTS CAN CARRY A KEY OR A TOKEN ────────────────────────────
 * The key is never printed at all, and the JWT is reported only by whether it
 * is there and when it expires. A token is short-lived, not harmless.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { readDictationKey } from "../src/dictation/credentials";
import { DEEPGRAM_GRANT_URL, grantDictationToken } from "../src/dictation/token";

const LIVE = process.env.TELAR_LIVE_SMOKE === "1";

/** Where a turn would look: this machine's engine root, then the environment. */
function smokeKey(): string | undefined {
  const home = process.env.TELAR_HOME?.trim();
  const pasted = home ? readDictationKey(path.join(home, "dictation")) : undefined;
  return pasted ?? process.env.DEEPGRAM_API_KEY?.trim() ?? undefined;
}

describe.skipIf(!LIVE)("Deepgram's grant endpoint, live", () => {
  test("mints a short-lived token for the key this Mac would actually spend", async () => {
    const key = smokeKey();
    if (!key) {
      // A SENTENCE, NOT A FAILURE. Asking for the smoke on a machine with no
      // key is a setup mistake, and saying which two places were empty is more
      // use than a red test.
      throw new Error("No Deepgram key found: paste one into Telar (with TELAR_HOME set) or export DEEPGRAM_API_KEY.");
    }

    const before = Date.now();
    // THE SHORTEST TTL THE ENDPOINT TAKES. The token is discarded on the next
    // line; minting a five-minute one to throw away is a credential left alive
    // for no reason.
    const answer = await grantDictationToken({ key, ttlSeconds: 1, url: DEEPGRAM_GRANT_URL });

    expect(answer.provider).toBe("deepgram");
    expect(answer.token.length).toBeGreaterThan(0);
    expect(answer.expiresAt).toBeGreaterThan(before);
    // Deepgram answers a JWT; three dot-separated parts is the shape, and it is
    // the one thing worth asserting about a credential that must not be logged.
    expect(answer.token.split(".")).toHaveLength(3);
  });
});
