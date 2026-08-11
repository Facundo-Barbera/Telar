import { expect, test } from "bun:test";
import { createClaudeDriver, ProviderUnavailableError } from "../src/driver";

test("the Claude seam forwards SDK text and accepts only an explicit successful result", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const text: string[] = [];
  await expect(driver.run({ prompt: "prompt", cwd: "/tmp", signal: new AbortController().signal, onText: async (part) => void text.push(part) })).resolves.toEqual({
    text: "hello",
  });
  expect(text).toEqual(["hello"]);
});

test("the Claude seam resumes and captures the SDK session id", async () => {
  let receivedResume: string | undefined;
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      receivedResume = input.options.resume;
      yield { type: "assistant", session_id: "claude-new-session", message: { content: [{ type: "text", text: "hello" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  await expect(
    driver.run({ prompt: "prompt", cwd: "/tmp", signal: new AbortController().signal, providerSessionId: "claude-prior-session", onText: async () => {} }),
  ).resolves.toEqual({ text: "hello", providerSessionId: "claude-new-session" });
  expect(receivedResume).toBe("claude-prior-session");
});

test("the Claude seam emits partial text deltas without duplicating the final assistant envelope", async () => {
  let includePartialMessages = false;
  const driver = createClaudeDriver(async () => ({
    async *query(input) {
      includePartialMessages = input.options.includePartialMessages;
      yield { type: "stream_event", session_id: "claude-stream", event: { type: "content_block_delta", delta: { type: "text_delta", text: "hel" } } };
      yield { type: "stream_event", session_id: "claude-stream", event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } } };
      yield { type: "assistant", session_id: "claude-stream", message: { content: [{ type: "text", text: "hello" }] } };
      yield { type: "result", subtype: "success" };
    },
  }));
  const text: string[] = [];
  await expect(driver.run({ prompt: "prompt", cwd: "/tmp", signal: new AbortController().signal, onText: async (part) => void text.push(part) })).resolves.toEqual({
    text: "hello",
    providerSessionId: "claude-stream",
  });
  expect(includePartialMessages).toBeTrue();
  expect(text).toEqual(["hel", "lo"]);
});

test("the Claude seam never turns an unsuccessful result into a completed turn", async () => {
  const driver = createClaudeDriver(async () => ({
    async *query() {
      yield { type: "result", subtype: "error_during_execution" };
    },
  }));
  await expect(driver.run({ prompt: "prompt", cwd: "/tmp", signal: new AbortController().signal, onText: async () => {} })).rejects.toThrow(
    "Claude did not complete successfully",
  );
});

test("a missing local SDK is a typed provider-unavailable failure", async () => {
  const driver = createClaudeDriver(async () => Promise.reject(new Error("missing")));
  await expect(driver.run({ prompt: "prompt", cwd: "/tmp", signal: new AbortController().signal, onText: async () => {} })).rejects.toBeInstanceOf(
    ProviderUnavailableError,
  );
});
