// @ts-expect-error bun:test is provided by the test runtime; this workspace does not install @types/bun
import { afterEach, describe, expect, test } from "bun:test";
import {
  endChatRun,
  isSessionRunLive,
  registerChatRun,
  setChatRunSession,
  stopChatRun,
} from "./chat-runs";

const ids = new Set<string>();
const id = (suffix: string) => {
  const value = `chat-runs-test-${suffix}-${crypto.randomUUID()}`;
  ids.add(value);
  return value;
};

afterEach(() => {
  for (const value of ids) endChatRun(value);
  ids.clear();
});

describe("chat run admission", () => {
  test("rejects a duplicate run id without replacing its stop handle", () => {
    const runId = id("duplicate");
    const first = new AbortController();
    const second = new AbortController();

    expect(registerChatRun(runId, first)).toBe(true);
    expect(registerChatRun(runId, second)).toBe(false);
    expect(stopChatRun(runId)).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(false);
  });

  test("admits at most one active turn per canonical session", () => {
    const sessionId = id("session");
    const firstId = id("first");
    const secondId = id("second");

    expect(registerChatRun(firstId, new AbortController(), sessionId)).toBe(true);
    expect(registerChatRun(secondId, new AbortController(), sessionId)).toBe(false);
    expect(isSessionRunLive(sessionId)).toBe(true);

    endChatRun(firstId);
    expect(registerChatRun(secondId, new AbortController(), sessionId)).toBe(true);
  });

  test("canonical adoption refuses a second draft run for the same session", () => {
    const sessionId = id("adopted-session");
    const firstId = id("draft-one");
    const secondId = id("draft-two");
    expect(registerChatRun(firstId, new AbortController())).toBe(true);
    expect(registerChatRun(secondId, new AbortController())).toBe(true);

    setChatRunSession(firstId, sessionId);
    expect(() => setChatRunSession(secondId, sessionId)).toThrow(
      `session ${sessionId} already has an active turn`,
    );
  });
});
