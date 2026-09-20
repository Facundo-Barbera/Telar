/**
 * #497 — THE SIXTEEN TRANSCRIPTS THAT STOP A SWITCH FLASHING WHITE.
 *
 * WHAT IS ACTUALLY AT STAKE HERE IS THE EVICTION RULE, not the storing. A cache
 * that keeps the wrong sixteen is a cache that misses on exactly the switch a
 * person makes most — back to the conversation they were just in — and a miss
 * is the blank frame this exists to remove. So the recency behaviour is what is
 * pinned: reading counts as use, re-remembering counts as use, and the entry
 * that leaves is the one nobody has touched.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { beforeEach, describe, expect, test } from "bun:test";
import type { Session } from "@telar/engine-client";
import {
  clearTranscriptCache,
  heldTranscripts,
  recallTranscript,
  rememberTranscript,
  transcriptKey,
  TRANSCRIPT_CACHE_LIMIT,
  type CachedTranscript,
} from "./transcript-cache";

beforeEach(() => clearTranscriptCache());

const transcript = (id: string): CachedTranscript => ({
  session: { id } as Session,
  turns: [],
  items: [],
  tasks: [],
  requests: [],
  events: [],
  cursor: 1,
});

describe("what the cache holds", () => {
  test("hands back exactly what it was given", () => {
    const key = transcriptKey("local", "session_1");
    const held = transcript("session_1");
    rememberTranscript(key, held);
    expect(recallTranscript(key)).toBe(held);
  });

  test("a conversation it does not hold is a miss, not an empty transcript", () => {
    // The difference matters: a miss means "read it", and an empty transcript
    // would mean "this conversation has no turns" — which would paint.
    expect(recallTranscript(transcriptKey("local", "never_seen"))).toBeUndefined();
  });

  test("the same conversation on two Macs is two conversations", () => {
    /**
     * Ids are minted per engine, so two paired Macs can hold the same one.
     * Answering one Mac's id with the other's transcript would paint the wrong
     * conversation — a worse failure than the flash this removes.
     */
    rememberTranscript(transcriptKey("local", "session_1"), transcript("local one"));
    rememberTranscript(transcriptKey("host_b", "session_1"), transcript("host_b one"));
    expect(recallTranscript(transcriptKey("local", "session_1"))?.session.id).toBe("local one");
    expect(recallTranscript(transcriptKey("host_b", "session_1"))?.session.id).toBe("host_b one");
  });
});

describe("which sixteen it keeps", () => {
  test("bounded at t3's sixteen, dropping the least recently used", () => {
    expect(TRANSCRIPT_CACHE_LIMIT).toBe(16);
    for (let n = 0; n < TRANSCRIPT_CACHE_LIMIT + 4; n += 1) {
      rememberTranscript(transcriptKey("local", `session_${n}`), transcript(`session_${n}`));
    }
    expect(heldTranscripts()).toHaveLength(TRANSCRIPT_CACHE_LIMIT);
    expect(recallTranscript(transcriptKey("local", "session_0"))).toBeUndefined();
    expect(recallTranscript(transcriptKey("local", "session_3"))).toBeUndefined();
    expect(recallTranscript(transcriptKey("local", "session_4"))).toBeDefined();
    expect(recallTranscript(transcriptKey("local", "session_19"))).toBeDefined();
  });

  test("reading counts as use, so the conversation you keep returning to survives", () => {
    for (let n = 0; n < TRANSCRIPT_CACHE_LIMIT; n += 1) {
      rememberTranscript(transcriptKey("local", `session_${n}`), transcript(`session_${n}`));
    }
    // The oldest, read once — which is what switching back to it IS.
    expect(recallTranscript(transcriptKey("local", "session_0"))).toBeDefined();
    rememberTranscript(transcriptKey("local", "newcomer"), transcript("newcomer"));
    // `session_1` was the oldest untouched entry, so it is the one that left.
    expect(recallTranscript(transcriptKey("local", "session_0"))).toBeDefined();
    expect(recallTranscript(transcriptKey("local", "session_1"))).toBeUndefined();
  });

  test("re-remembering an unchanged transcript refreshes its place in line", () => {
    /**
     * The cockpit re-remembers on every tail — once a second, per open
     * conversation — precisely so the transcript being READ RIGHT NOW cannot
     * age out behind fifteen opened once and abandoned.
     */
    for (let n = 0; n < TRANSCRIPT_CACHE_LIMIT; n += 1) {
      rememberTranscript(transcriptKey("local", `session_${n}`), transcript(`session_${n}`));
    }
    const open = transcriptKey("local", "session_0");
    rememberTranscript(open, transcript("session_0"));
    rememberTranscript(transcriptKey("local", "newcomer"), transcript("newcomer"));
    expect(recallTranscript(open)).toBeDefined();
    expect(heldTranscripts()).toHaveLength(TRANSCRIPT_CACHE_LIMIT);
  });

  test("a replacement is one entry, not two", () => {
    const key = transcriptKey("local", "session_1");
    rememberTranscript(key, transcript("first"));
    rememberTranscript(key, transcript("second"));
    expect(heldTranscripts()).toHaveLength(1);
    expect(recallTranscript(key)?.session.id).toBe("second");
  });
});
