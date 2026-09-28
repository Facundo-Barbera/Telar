/** `useInboxPolicy` is mounted by several surfaces at once; one read per host is shared, never across Macs. */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import type { InboxPolicy } from "@telar/engine-client";
import { forgetInboxPolicies, INBOX_POLICY_TTL_MS, readInboxPolicy, rememberInboxPolicy } from "./inbox-policy";

const policy = (hours: number | null): InboxPolicy => ({ autoSettleAfterHours: hours }) as InboxPolicy;

afterEach(() => forgetInboxPolicies());

describe("readInboxPolicy", () => {
  test("nine callers in one navigation make one request", async () => {
    let calls = 0;
    const fetchPolicy = async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return policy(20);
    };
    const answers = await Promise.all(Array.from({ length: 9 }, () => readInboxPolicy("local", fetchPolicy)));
    expect(calls).toBe(1);
    expect(answers.every((answer) => answer.autoSettleAfterHours === 20)).toBe(true);
  });

  test("a later caller is served the answer without asking again", async () => {
    let calls = 0;
    const fetchPolicy = async () => {
      calls += 1;
      return policy(72);
    };
    let clock = 1_000;
    const now = () => clock;
    await readInboxPolicy("local", fetchPolicy, now);
    clock += INBOX_POLICY_TTL_MS - 1;
    await readInboxPolicy("local", fetchPolicy, now);
    expect(calls).toBe(1);
  });

  test("past the window it reads again — the event covers in-app changes, this covers the rest", async () => {
    let calls = 0;
    const fetchPolicy = async () => {
      calls += 1;
      return policy(72);
    };
    let clock = 1_000;
    const now = () => clock;
    await readInboxPolicy("local", fetchPolicy, now);
    clock += INBOX_POLICY_TTL_MS + 1;
    await readInboxPolicy("local", fetchPolicy, now);
    expect(calls).toBe(2);
  });

  test("one Mac's policy is never served for another", async () => {
    // The api follows the address bar, so a host-blind cache would band a remote rail by this Mac's window.
    const asked: string[] = [];
    const fetchFor = (hostId: string) => async () => {
      asked.push(hostId);
      return policy(hostId === "local" ? 20 : 72);
    };
    expect((await readInboxPolicy("local", fetchFor("local"))).autoSettleAfterHours).toBe(20);
    expect((await readInboxPolicy("host_b", fetchFor("host_b"))).autoSettleAfterHours).toBe(72);
    expect(asked).toEqual(["local", "host_b"]);
  });

  test("a failed read is not remembered as an answer", async () => {
    let calls = 0;
    const fetchPolicy = async () => {
      calls += 1;
      if (calls === 1) throw new Error("engine away");
      return policy(20);
    };
    await expect(readInboxPolicy("local", fetchPolicy)).rejects.toThrow("engine away");
    expect((await readInboxPolicy("local", fetchPolicy)).autoSettleAfterHours).toBe(20);
    expect(calls).toBe(2);
  });

  test("a read already in flight cannot overwrite what a save just accepted", async () => {
    /** A read that started before a save must not commit its stale value after the save lands. */
    let release: (policy: InboxPolicy) => void = () => undefined;
    const deferred = new Promise<InboxPolicy>((resolve) => {
      release = resolve;
    });
    const reading = readInboxPolicy("local", () => deferred);

    rememberInboxPolicy("local", policy(48));
    release(policy(20)); // the older read, answering late
    // Its own callers are handed the authoritative value, not the stale one.
    expect((await reading).autoSettleAfterHours).toBe(48);

    let calls = 0;
    const answer = await readInboxPolicy("local", async () => {
      calls += 1;
      return policy(20);
    });
    expect(answer.autoSettleAfterHours).toBe(48);
    expect(calls).toBe(0);
  });

  test("a save on one Mac does not outrank another Mac's in-flight read", async () => {
    let release: (policy: InboxPolicy) => void = () => undefined;
    const deferred = new Promise<InboxPolicy>((resolve) => {
      release = resolve;
    });
    const readingB = readInboxPolicy("host_b", () => deferred);
    rememberInboxPolicy("local", policy(48));
    release(policy(72));
    expect((await readingB).autoSettleAfterHours).toBe(72);
    expect((await readInboxPolicy("local", async () => policy(1))).autoSettleAfterHours).toBe(48);
  });

  test("what the engine just accepted is what later mounts get, with no request", async () => {
    let calls = 0;
    const fetchPolicy = async () => {
      calls += 1;
      return policy(20);
    };
    rememberInboxPolicy("local", policy(48));
    expect((await readInboxPolicy("local", fetchPolicy)).autoSettleAfterHours).toBe(48);
    expect(calls).toBe(0);
  });
});
