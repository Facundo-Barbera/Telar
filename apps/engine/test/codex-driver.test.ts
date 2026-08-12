/**
 * The Codex seam, driven through a REAL `codex app-server` subprocess.
 *
 * WHY A SUBPROCESS AND NOT A MOCK. Every bug this driver exists to avoid lives
 * at the transport: a handler awaited inside the stdout reader, a server→client
 * request nobody answered, a `decision` spelled in the wrong vocabulary. None
 * of those are reachable from an injected async iterable — they are properties
 * of stdio framing, of ordering, and of what got written back. So the fake
 * app-server is a real process, reached the way production reaches Codex
 * (`CODEX_BIN`), and the assertions are made on the observations the driver
 * produced AND on the bytes it wrote (the fixture's request/response tape).
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RequestDecision, TurnObservation } from "@telar/engine-client";
import { codexSandboxPolicy, codexTurnInput, createCodexDriver, type CodexDriverOptions } from "../src/codex-driver";
import { codexUsage } from "../src/codex/items";
import { ProviderUnavailableError, type DriverRequest } from "../src/driver";

const FAKE_BIN = fileURLToPath(new URL("./fixtures/fake-codex-app-server.mjs", import.meta.url));

let previousCodexBin: string | undefined;
let logDir: string;
let logPath: string;

beforeEach(() => {
  previousCodexBin = process.env.CODEX_BIN;
  process.env.CODEX_BIN = FAKE_BIN;
  logDir = mkdtempSync(join(tmpdir(), "codex-driver-"));
  logPath = join(logDir, "wire.jsonl");
});

afterEach(() => {
  if (previousCodexBin === undefined) delete process.env.CODEX_BIN;
  else process.env.CODEX_BIN = previousCodexBin;
  rmSync(logDir, { recursive: true, force: true });
});

type Recorded = { method: string; params: Record<string, unknown> | null };

const wire = (): Recorded[] =>
  readFileSync(logPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Recorded);

function sent(method: string): Record<string, unknown> {
  const hit = wire().find((entry) => entry.method === method);
  if (!hit) throw new Error(`no ${method} on the wire: ${JSON.stringify(wire().map((e) => e.method))}`);
  return hit.params ?? {};
}

/** Everything the client replied to a server→client request. */
const replies = (): Array<{ id: number; result: Record<string, unknown> | null; error: { code: number } | null }> =>
  wire()
    .filter((entry) => entry.method === "@response")
    .map((entry) => entry.params as never);

type RunOptions = {
  prompt?: string;
  cwd?: string;
  providerSessionId?: string;
  onRequest?: (request: DriverRequest) => Promise<RequestDecision>;
  controller?: AbortController;
  options?: CodexDriverOptions;
};

function runTurn(scenario: string, run: RunOptions = {}) {
  const observations: TurnObservation[] = [];
  const controller = run.controller ?? new AbortController();
  const driver = createCodexDriver({
    ...run.options,
    env: { FAKE_CODEX_TURN_SCENARIO: scenario, FAKE_CODEX_PARAMS_LOG: logPath, ...run.options?.env },
  });
  const result = driver.run({
    prompt: run.prompt ?? "hi",
    cwd: run.cwd ?? "/tmp/project",
    signal: controller.signal,
    onObservations: async (batch) => void observations.push(...batch),
    ...(run.providerSessionId ? { providerSessionId: run.providerSessionId } : {}),
    ...(run.onRequest ? { onRequest: run.onRequest } : {}),
  });
  return { result, observations, controller };
}

const started = (observations: TurnObservation[]) => observations.filter((o) => o.kind === "item.started");
const completed = (observations: TurnObservation[]) => observations.filter((o) => o.kind === "item.completed");
const deltas = (observations: TurnObservation[]) => observations.filter((o) => o.kind === "content.delta");

// ── the ordinary turn ──────────────────────────────────────────────────────

test("a turn streams its text as deltas and does not double it on completion", async () => {
  const { result, observations } = runTurn("plain");
  await expect(result).resolves.toMatchObject({ text: "hello", providerSessionId: "fake-thread" });

  expect(deltas(observations).map((o) => (o.kind === "content.delta" ? o.text : ""))).toEqual(["hel", "lo"]);
  // THE DOUBLE-COUNT GUARD. Codex re-sends an agentMessage's FULL text on
  // `item/completed`; appending it after streaming produces "hellohello" in the
  // turn result and a duplicated transcript. One row, one copy of the text.
  const messages = started(observations).filter((o) => o.kind === "item.started" && o.item.detail.type === "assistant_message");
  expect(messages).toHaveLength(1);
});

test("usage comes from tokenUsage.last, never .total, and carries no invented price", async () => {
  const { result, observations } = runTurn("plain");
  const resolved = await result;

  // `.total` is cumulative across the thread's whole history — reading it here
  // re-bills every earlier turn of a resumed session on every subsequent one.
  // The fixture's totals are 9000s precisely so a `.total` read is unmistakable.
  expect(resolved.usage).toEqual({
    tokens: { input: 120, output: 45, cacheRead: 30, cacheCreate: 10, reasoning: 12 },
    contextUsed: 195,
    contextMax: 400_000,
  });
  // Codex quotes no price anywhere on this wire. An absent figure is the honest
  // answer; a computed one would be a second definition of what a turn cost.
  expect(resolved.usage && "costUsd" in resolved.usage).toBeFalse();
  // The child thread's usage is its own turn's, not this one's.
  expect(observations.filter((o) => o.kind === "usage")).toHaveLength(1);
});

test("a usage update for the wrong shape reports nothing rather than zeros", () => {
  // Anti-vacuity for the mapping above: a snapshot with no `last` must not
  // become a zeroed reading that looks like a turn which cost nothing.
  expect(codexUsage({ tokenUsage: { total: { inputTokens: 10 }, modelContextWindow: 400000 } })).toBeUndefined();
  expect(codexUsage({})).toBeUndefined();
});

// ── the wire ───────────────────────────────────────────────────────────────

test("turn/start sends the app-server's own input shape, snake_case field and all", async () => {
  await runTurn("plain", { prompt: "hello codex" }).result;
  // `text_elements` is REQUIRED and is snake_case alone among every field on
  // this wire. A text item without it is rejected, and "tidying" it is the
  // change that would do it.
  expect(sent("turn/start").input).toEqual([{ type: "text", text: "hello codex", text_elements: [] }]);
  expect(codexTurnInput("x")).toEqual([{ type: "text", text: "x", text_elements: [] }]);
});

test("the app-server is launched with exactly one argument and told everything else in params", async () => {
  await runTurn("plain").result;
  // Config on an argv is world-readable through `ps` to every process running
  // as this user — including the sandboxed shells of the agent sessions.
  const argv = sent("@argv").argv as string[];
  expect(argv.slice(1)).toEqual(["app-server"]);
  expect(sent("initialize")).toEqual({
    clientInfo: { name: "telar", title: "Telar", version: "0.1.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  });
});

test("empty capability fields are OMITTED, because an empty one is a different statement", async () => {
  await runTurn("plain").result;
  const params = sent("thread/start");
  // `dynamicTools: []` says "this client has no tools", which is not the same
  // sentence as saying nothing — and a resumed thread that says it LOSES the
  // tools it started with. Same for developerInstructions and config.
  expect("dynamicTools" in params).toBeFalse();
  expect("developerInstructions" in params).toBeFalse();
  expect("config" in params).toBeFalse();
  expect(params).toMatchObject({ cwd: "/tmp/project", model: "gpt-5.5" });
});

test("a resumed turn resumes the thread and never opens a second one", async () => {
  const { result } = runTurn("plain", { providerSessionId: "thread-42" });
  await expect(result).resolves.toMatchObject({ providerSessionId: "thread-42" });
  expect(sent("thread/resume").threadId).toBe("thread-42");
  // A resume that also started a thread would silently orphan the history the
  // engine handed over.
  expect(wire().some((entry) => entry.method === "thread/start")).toBeFalse();
});

test("the posture follows whether the engine wired a gate at all", async () => {
  await runTurn("plain").result;
  // No `onRequest` is the full-access shape `driver.ts` documents: nothing to
  // ask, so Codex is told not to.
  expect(sent("turn/start")).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });

  rmSync(logPath, { force: true });
  await runTurn("plain", { onRequest: async () => "accept" }).result;
  // A gate exists, so Codex asks about everything and the ENGINE decides. Codex
  // must never apply a second policy on top of the engine's — two deciders,
  // one audit trail.
  expect(sent("turn/start")).toMatchObject({
    approvalPolicy: "on-request",
    sandboxPolicy: { type: "workspaceWrite", writableRoots: ["/tmp/project"], networkAccess: true },
  });
});

test("an explicit thread config overrides the derived posture", async () => {
  await runTurn("plain", {
    onRequest: async () => "accept",
    options: { threadConfig: { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" } },
  }).result;
  expect(sent("thread/start")).toMatchObject({ approvalPolicy: "untrusted", sandbox: "read-only" });
  // The per-turn policy is what actually decides network access, and it is
  // derived from the same value so the two can never disagree.
  expect(sent("turn/start").sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
  expect(codexSandboxPolicy("danger-full-access", "/x")).toEqual({ type: "dangerFullAccess" });
});

// ── items ──────────────────────────────────────────────────────────────────

test("reasoning is its own row, is filled in from deltas, and never joins the answer", async () => {
  const { result, observations } = runTurn("reasoning");
  await expect(result).resolves.toMatchObject({ text: "answer" });

  const delta = deltas(observations)[0];
  expect(delta?.kind === "content.delta" && delta.stream).toBe("reasoning_text");
  // Codex sends reasoning text ONLY as deltas — the completed item carries
  // none — so a stored row would read empty unless the driver keeps the
  // accumulation and puts it back.
  const closed = completed(observations).find((o) => o.kind === "item.completed" && o.detail?.type === "reasoning");
  expect(closed?.kind === "item.completed" && closed.detail?.type === "reasoning" && closed.detail.text).toBe(
    "weighing options",
  );
});

test("tool items land on the canonical rows a Claude turn would produce", async () => {
  const { result, observations } = runTurn("tools");
  await result;
  const rows = started(observations).map((o) => (o.kind === "item.started" ? o.item : null));

  const command = rows.find((row) => row?.detail.type === "command_execution");
  expect(command?.detail.type === "command_execution" && command.detail.command.command).toBe("ls -la /tmp");
  expect(command?.title).toBe("ls -la /tmp");

  const change = rows.find((row) => row?.detail.type === "file_change");
  expect(change?.detail.type === "file_change" && change.detail.change).toEqual({ path: "src/a.ts", kind: "edit" });
  // One Codex item is one row, so a multi-file patch says so rather than
  // pretending it touched one file.
  expect(change?.title).toBe("src/a.ts (+1 more)");

  const mcp = rows.find((row) => row?.detail.type === "mcp_tool_call");
  expect(mcp?.detail.type === "mcp_tool_call" && mcp.detail.call.server).toBe("linear");

  expect(rows.some((row) => row?.detail.type === "web_search")).toBeTrue();
  // THE LOAD-BEARING CASE: an item type this driver has never heard of still
  // produces a row. Codex ships new item types faster than this file learns
  // them, and a silently missing row is worse than an ugly one.
  const unknown = rows.find((row) => row?.detail.type === "unknown");
  expect(unknown?.detail.type === "unknown" && unknown.detail.label).toBe("quantumEntanglement");
});

test("a completed command carries its output and exit code back onto its own row", async () => {
  const { result, observations } = runTurn("tools");
  await result;
  const openRow = started(observations).find((o) => o.kind === "item.started" && o.item.detail.type === "command_execution");
  const closedRow = completed(observations).find((o) => o.kind === "item.completed" && o.detail?.type === "command_execution");
  // Keyed off Codex's item id, so the completion closes the row its start
  // opened rather than opening a second one.
  expect(closedRow?.kind === "item.completed" && closedRow.itemId).toBe(
    openRow?.kind === "item.started" ? openRow.item.id : "",
  );
  expect(closedRow?.kind === "item.completed" && closedRow.detail?.type === "command_execution" && closedRow.detail.command).toMatchObject(
    { outputPreview: "total 0\n", exitCode: 0 },
  );
});

test("a declined item is declined, not failed — nothing went wrong", async () => {
  const { result, observations } = runTurn("declined");
  await result;
  const closed = completed(observations)[0];
  expect(closed?.kind === "item.completed" && closed.status).toBe("declined");
});

test("a failed item is failed", async () => {
  // The discriminating half of the case above: the two statuses must not be
  // collapsed in either direction.
  const { result, observations } = runTurn("failed-tool");
  await result;
  const closed = completed(observations)[0];
  expect(closed?.kind === "item.completed" && closed.status).toBe("failed");
});

test("a republished item is the same row, not a second one", async () => {
  const { result, observations } = runTurn("repeat-snapshot");
  await result;
  const patches = started(observations).filter((o) => o.kind === "item.started" && o.item.detail.type === "file_change");
  expect(patches).toHaveLength(1);
  expect(completed(observations).filter((o) => o.kind === "item.completed" && o.detail?.type === "file_change")).toHaveLength(1);
});

test("a row the app-server never closes is closed as failed, not left spinning", async () => {
  const { result, observations } = runTurn("abandoned-item");
  await result;
  const closed = completed(observations).find(
    (o) => o.kind === "item.completed" && started(observations).some((s) => s.kind === "item.started" && s.item.detail.type === "command_execution" && s.item.id === o.itemId),
  );
  expect(closed?.kind === "item.completed" && closed.status).toBe("failed");
});

test("the plan is one row updated in place, not a new checklist per revision", async () => {
  const { result, observations } = runTurn("plan");
  await result;
  const plans = observations.filter(
    (o) => (o.kind === "item.started" || o.kind === "item.updated") && o.item.detail.type === "plan",
  );
  expect(plans.map((o) => o.kind)).toEqual(["item.started", "item.updated"]);
  // Same row id both times — the legacy bridge minted a fresh TodoWrite-shaped
  // tool call per update and left the transcript full of near-identical lists.
  const [first, second] = plans;
  expect(first?.kind === "item.started" && second?.kind === "item.updated" && first.item.id === second.item.id).toBeTrue();
  expect(second?.kind === "item.updated" && second.item.detail.type === "plan" && second.item.detail.plan.steps[0]).toEqual({
    step: "read the driver",
    status: "completed",
  });
});

test("mid-turn compaction is keyed off the item, and the turn still ends", async () => {
  // The legacy bridge waited for a `thread/compacted` notification that is dead
  // in current Codex; the fixture never sends one, so a driver that waited
  // would hang here instead of finishing.
  const { result, observations } = runTurn("auto-compact");
  await expect(result).resolves.toMatchObject({ text: "done" });
  expect(started(observations).some((o) => o.kind === "item.started" && o.item.detail.type === "context_compaction")).toBeTrue();
});

test("a child thread's work is visible but is never mistaken for this turn's", async () => {
  const { result, observations } = runTurn("child-thread");
  // The parent's answer only. A sub-agent's prose is not what the human asked.
  await expect(result).resolves.toMatchObject({ text: "parent answer" });
  const childRow = started(observations).find(
    (o) => o.kind === "item.started" && o.item.providerRefs?.sessionId === "fake-child-thread",
  );
  // Emitted, not dropped: `ItemSeed` cannot carry a task id yet, so the child
  // thread id rides in providerRefs for a later task mapping to key off.
  expect(childRow).toBeDefined();
});

// ── approvals ──────────────────────────────────────────────────────────────

test("an approval is answered without stalling the stream behind it", async () => {
  // THE DEADLOCK TEST. The fixture keeps streaming while the approval is
  // outstanding, and this handler refuses to answer until it has SEEN one of
  // those deltas. A driver that awaited its approval handler inside the stdout
  // reader can never satisfy both, and this test times out instead of passing.
  const seenDelta = Promise.withResolvers<void>();
  let request: DriverRequest | undefined;
  const { result, observations } = runTurn("approval-command", {
    onRequest: async (incoming) => {
      request = incoming;
      await seenDelta.promise;
      return "accept";
    },
  });
  const poll = setInterval(() => {
    if (deltas(observations).length > 0) seenDelta.resolve();
  }, 5);
  try {
    await expect(result).resolves.toMatchObject({ text: "ok" });
  } finally {
    clearInterval(poll);
  }

  expect(request?.kind).toBe("command_execution");
  expect(request?.detail.kind === "command_execution" && request.detail.command).toEqual({
    command: "rm -rf /tmp/scratch",
    cwd: "/tmp",
  });
  // The row and the request correlate through Codex's own item id.
  expect(request?.toolUseId).toBe("item-cmd");
  expect(replies().at(-1)?.result).toEqual({ decision: "accept" });
});

test("a decline is spelled the way the item/* pair expects", async () => {
  const { result } = runTurn("approval-command", { onRequest: async () => "decline" });
  await result;
  expect(replies().at(-1)?.result).toEqual({ decision: "decline" });
});

test("acceptForSession is an accept to Codex — the widening is the engine's to record", async () => {
  const { result } = runTurn("approval-command", { onRequest: async () => "acceptForSession" });
  await result;
  expect(replies().at(-1)?.result).toEqual({ decision: "accept" });
});

test("the legacy approval pair is answered in the OTHER vocabulary", async () => {
  const { result } = runTurn("approval-legacy", { onRequest: async () => "accept" });
  // `approved`, not `accept`. Sending the item/* spelling here is not an error
  // the app-server reports — it is a decision it ignores.
  await expect(result).resolves.toMatchObject({ text: "decision=approved" });
  expect(replies().at(-1)?.result).toEqual({ decision: "approved" });
});

test("the legacy pair's argv command is joined into one shell line", async () => {
  let request: DriverRequest | undefined;
  await runTurn("approval-legacy", {
    onRequest: async (incoming) => {
      request = incoming;
      return "decline";
    },
  }).result;
  expect(request?.detail.kind === "command_execution" && request.detail.command.command).toBe("git push --force");
  expect(replies().at(-1)?.result).toEqual({ decision: "denied" });
});

test("a file-change approval arrives as a file_change request, not a generic tool call", async () => {
  let request: DriverRequest | undefined;
  await runTurn("approval-file", {
    onRequest: async (incoming) => {
      request = incoming;
      return "accept";
    },
  }).result;
  // Kinds are coarse by capability: what the human is being asked is "may you
  // write files here", which is one decision whatever the tool is called.
  expect(request?.kind).toBe("file_change");
  expect(request?.detail.kind === "file_change" && request.detail.change).toEqual({ path: "src/new.ts", kind: "create" });
});

test("a gate that throws declines, because the app-server has no deadline", async () => {
  const { result } = runTurn("approval-command", {
    onRequest: async () => {
      throw new Error("the engine went away");
    },
  });
  await result;
  expect(replies().at(-1)?.result).toEqual({ decision: "decline" });
});

test("a cancelled approval withdraws the whole turn after the decline is on the wire", async () => {
  const { result } = runTurn("approval-command", { onRequest: async () => "cancel" });
  // `cancel` is not "no to this call", it is "stop", and the difference is
  // exactly this: the fixture goes on to finish the turn normally after a
  // decline, so a driver that treated cancel as an ordinary decline would
  // RESOLVE here with the turn's text instead of withdrawing.
  await expect(result).rejects.toThrow("cancelled this turn");
});

test("with no gate wired, an approval is refused rather than left hanging", async () => {
  // approvalPolicy is "never" in this posture so the app-server should not ask
  // — but if it does, an unanswered request stops the turn forever.
  const { result } = runTurn("approval-command");
  await expect(result).resolves.toMatchObject({ text: "ok" });
  expect(replies().at(-1)?.error?.code).toBe(-32601);
});

test("a server request this client has never heard of is still answered", async () => {
  // The fixture will not finish the turn until it gets a reply. Every
  // server→client request must be answered — including the ones from a Codex
  // newer than this driver — or the app-server waits, and so does the human.
  const { result } = runTurn("unknown-request");
  await expect(result).resolves.toMatchObject({ text: "done" });
  expect(replies().at(-1)?.error?.code).toBe(-32601);
});

// ── failure ────────────────────────────────────────────────────────────────

test("a fatal error notification fails the turn with the server's own message", async () => {
  await expect(runTurn("error").result).rejects.toThrow("fake fatal failure");
});

test("a retryable error is a row, not the end of the turn", async () => {
  // Ending here would fail a turn that goes on to succeed — the app-server said
  // it would try again.
  const { result, observations } = runTurn("error-retryable");
  await expect(result).resolves.toMatchObject({ text: "done" });
  const errorRow = started(observations).find((o) => o.kind === "item.started" && o.item.detail.type === "error");
  expect(errorRow?.kind === "item.started" && errorRow.item.detail.type === "error" && errorRow.item.detail.error.message).toBe(
    "rate limited, retrying",
  );
});

test("a failed turn is never reported as a completed one", async () => {
  await expect(runTurn("turn-failed").result).rejects.toThrow("model refused the turn");
});

test("a missing Codex is a typed provider-unavailable failure, before any subprocess exists", async () => {
  process.env.CODEX_BIN = join(logDir, "definitely-not-codex");
  // A binary that is not there must read as a binary that is not there — the
  // legacy resolver spawned it anyway and reported "app-server exited
  // (code=null)", which told the user nothing about what to install.
  await expect(runTurn("plain").result).rejects.toBeInstanceOf(ProviderUnavailableError);
});

test("an abort ends the turn rather than waiting out the subprocess", async () => {
  const controller = new AbortController();
  const { result } = runTurn("plain", { controller });
  controller.abort(new Error("turn stopped"));
  await expect(result).rejects.toThrow("turn stopped");
});
