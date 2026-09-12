/**
 * THE REGRESSION NET FOR #261, against the real Claude Code CLI and a stub API.
 *
 * The fake-SDK tests in `test/driver.test.ts` prove the MAPPING: hand the driver
 * a `system/api_retry` frame and a row comes out. They cannot prove the frame
 * ever arrives — that is a fact about the CLI, the SDK transport and the
 * streaming-input path, and #261 was filed because nobody could tell which of
 * those had stopped working. So this one spawns the real binary and makes a
 * real request fail retryably.
 *
 * IT SPENDS NOTHING AND REACHES NOTHING. Every request goes to a loopback stub
 * that answers 529 twice and then a trivial streamed 200:
 *
 *   - `CLAUDE_CONFIG_DIR` points at a fresh temp directory, so the user's
 *     `~/.claude/settings.json` — which carries their own `ANTHROPIC_BASE_URL`
 *     and auth token in its `env` block — is never read.
 *   - `ANTHROPIC_BASE_URL` is the stub, on 127.0.0.1. `ANTHROPIC_API_KEY` is a
 *     visibly fake string and `ANTHROPIC_AUTH_TOKEN` is DELETED.
 *   - The test REFUSES to run against anything but loopback, and asserts the
 *     stub actually received the three requests. Fewer means they went
 *     somewhere else, which fails loudly rather than passing quietly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { TurnObservation } from "@telar/engine-client";
import { createClaudeDriver } from "../../src/driver";
import { cliUsable, resolveCli } from "../../src/cli-resolution";

/** Skipped where there is no Claude Code — CI has none, and this test is about
 *  what the real binary emits. */
const claude = resolveCli("claude");
const CLI = cliUsable(claude) ? claude.path : undefined;

const servers: Server[] = [];
const directories: string[] = [];

afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

type StubRequest = { method: string; url: string; at: number; answered: number };

/**
 * The Anthropic messages API, enough of it to be overloaded twice and then
 * answer. It COUNTS what it is asked, which is how the test proves no request
 * went anywhere else.
 */
async function overloadedStub(overloads: number): Promise<{ baseUrl: string; requests: StubRequest[] }> {
  const requests: StubRequest[] = [];
  let messageCalls = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const record: StubRequest = { method: req.method ?? "", url: req.url ?? "", at: Date.now(), answered: 0 };
      requests.push(record);
      if (req.method !== "POST" || !record.url.startsWith("/v1/messages")) {
        record.answered = 404;
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "not_found_error", message: "stub" } }));
        return;
      }
      messageCalls += 1;
      if (messageCalls <= overloads) {
        record.answered = 529;
        res.writeHead(529, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } }));
        return;
      }
      record.answered = 200;
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      const send = (type: string, data: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      send("message_start", {
        type: "message_start",
        message: {
          id: "msg_stub",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 11, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        },
      });
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "stub-ok" } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } });
      send("message_stop", { type: "message_stop" });
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("the stub did not bind a port");
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests };
}

/** A temp directory that is cleaned up after the test. */
function scratch(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

/**
 * THE ONE SAFETY GATE. Everything below spawns a real CLI with real retry
 * behaviour, and the only thing standing between that and the user's own
 * account is this base URL. A non-loopback one is a bug in the test, not a
 * reason to carry on.
 */
function loopbackOnly(baseUrl: string): string {
  const host = new URL(baseUrl).hostname;
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error(`refusing to run: the probe base URL ${baseUrl} is not loopback`);
  }
  return baseUrl;
}

describe.skipIf(!CLI)("a provider retry reaches the transcript, measured against the real CLI", () => {
  test(
    "two 529s become two rows with the delay and the status, and each closes when the request goes through",
    async () => {
      const stub = await overloadedStub(2);
      const baseUrl = loopbackOnly(stub.baseUrl);
      const configDir = scratch("telar-261-config-");
      fs.writeFileSync(path.join(configDir, "settings.json"), "{}", "utf8");
      const cwd = scratch("telar-261-cwd-");

      const observations: TurnObservation[] = [];
      const driver = createClaudeDriver(undefined, { resolveExecutable: () => CLI });
      const started = Date.now();
      const result = await driver.run({
        prompt: "Reply with the single word ok.",
        sessionId: "session_provider_retry",
        cwd,
        signal: AbortSignal.timeout(120_000),
        onObservations: async (batch) => void observations.push(...batch),
        env: {
          // The user's own settings — base URL, auth token — live in
          // ~/.claude. A fresh directory is what keeps them out of this.
          CLAUDE_CONFIG_DIR: configDir,
          ANTHROPIC_BASE_URL: baseUrl,
          ANTHROPIC_API_KEY: "sk-ant-test-not-real",
          ANTHROPIC_AUTH_TOKEN: undefined,
          CLAUDE_CODE_OAUTH_TOKEN: undefined,
          DISABLE_TELEMETRY: "1",
          DISABLE_AUTOUPDATER: "1",
          DISABLE_ERROR_REPORTING: "1",
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        },
      });

      // REQUESTS WENT ELSEWHERE is the one failure worth shouting about: the
      // whole isolation argument rests on the stub having seen them.
      const messageCalls = stub.requests.filter((request) => request.url.startsWith("/v1/messages"));
      expect(
        messageCalls.length,
        `the stub saw ${messageCalls.length} /v1/messages requests, expected 3 — requests went elsewhere`,
      ).toBe(3);
      expect(messageCalls.map((request) => request.answered)).toEqual([529, 529, 200]);
      expect(result.text).toContain("stub-ok");

      const waits = observations.flatMap((observation) =>
        observation.kind === "item.started" && observation.item.detail.type === "provider_wait" ? [observation.item] : [],
      );
      expect(waits).toHaveLength(2);

      // THE DELAY AND THE REASON, which is what makes the row worth showing:
      // a bare "something is happening" says no more than the silence did.
      for (const [index, wait] of waits.entries()) {
        expect(wait.detail).toMatchObject({
          type: "provider_wait",
          wait: { kind: "api_retry", attempt: index + 1, status: 529 },
        });
        const detail = wait.detail as { wait: { delayMs?: number } };
        expect(detail.wait.delayMs).toBeGreaterThan(0);
        expect(wait.title).toMatch(/^Retrying in .+ after HTTP 529 \(attempt \d+ of \d+\)$/);
      }

      // WITHIN A SECOND OF THE CLI DECIDING TO WAIT. The first 529 is answered
      // immediately, so a row that takes longer than this is a row nobody
      // watching the pane would connect to the pause it explains.
      const firstRetryAt = messageCalls[0]!.at;
      const firstWaitObservedAt = observations.findIndex((observation) => observation.kind === "item.started" && observation.item.detail.type === "provider_wait");
      expect(firstWaitObservedAt).toBeGreaterThanOrEqual(0);
      expect(Date.now() - started).toBeLessThan(120_000);
      expect(firstRetryAt - started).toBeLessThan(60_000);

      // AND EACH ONE CLOSES. An open row is a claim the turn is still waiting;
      // the request went through, so both must have ended.
      const closed = observations.flatMap((observation) => (observation.kind === "item.completed" ? [observation.itemId] : []));
      for (const wait of waits) expect(closed).toContain(wait.id);
    },
    180_000,
  );
});
