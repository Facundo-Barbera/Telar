import { describe, expect, test } from "bun:test";
import path from "node:path";
import { readDictationKey } from "./credentials";
import { DEEPGRAM_GRANT_URL, grantDictationToken } from "./token";

const LIVE = process.env.TELAR_LIVE_SMOKE === "1";

function smokeKey(): string | undefined {
  const home = process.env.TELAR_HOME?.trim();
  const pasted = home ? readDictationKey(path.join(home, "dictation")) : undefined;
  return pasted ?? process.env.DEEPGRAM_API_KEY?.trim() ?? undefined;
}

describe.skipIf(!LIVE)("Deepgram's grant endpoint, live", () => {
  test("mints a short-lived token for the key this Mac would actually spend", async () => {
    const key = smokeKey();
    if (!key) {
      throw new Error("No Deepgram key found: paste one into Telar (with TELAR_HOME set) or export DEEPGRAM_API_KEY.");
    }

    const before = Date.now();
    const answer = await grantDictationToken({ key, language: "multi", ttlSeconds: 1, url: DEEPGRAM_GRANT_URL });

    expect(answer.provider).toBe("deepgram");
    expect(answer.token.length).toBeGreaterThan(0);
    expect(answer.expiresAt).toBeGreaterThan(before);
    expect(answer.token.split(".")).toHaveLength(3);
  });
});
