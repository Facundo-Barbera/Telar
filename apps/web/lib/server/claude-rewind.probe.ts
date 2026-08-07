// THE REWIND PROBE (message-lifecycle STEP 0) — a bun script, not a test.
// Every step of the lifecycle build branches on answers only a RUNNING CLI can
// give, so this measures them against the pinned SDK + its matched CLI and
// prints `PROBE <key>: <value>` lines. Run it manually:
//
//   cd apps/web && bun lib/server/claude-rewind.probe.ts
//
// It spawns a handful of tiny real turns in a throwaway cwd (subscription
// cost: cents), then answers, in order:
//   (a) does the CLI adopt a client-supplied uuid on a streaming-input
//       SDKUserMessage as the chain-entry uuid (read back from the session's
//       own JSONL);
//   (b) does resume + resumeSessionAt truncate on the headless lane, and does
//       a subsequent PLAIN resume follow the truncated branch — the sticky-
//       anchor decision (STEP 4's pendingFork send policy) hangs on this;
//   (c) the exact refusal text/result shape for a bad resumeDropsTurn, plus
//       the success shape for a valid one;
//   (d) initializationResult() capabilities and the interrupt() receipt;
//   (e) whether the same query accepts a new turn after interrupt().
//
// Results are recorded by hand into
// _bmad-output/implementation-artifacts/deferred-work.md — the script prints,
// a human (or the calling agent) transcribes, because the findings doc wants
// prose context, not raw dumps.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { query, type SDKMessage, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "telar-rewind-probe-"));
const note = (key: string, value: unknown) => {
  console.log(`PROBE ${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
};

// The whole probe is bounded — a wedged CLI must not outlive its usefulness.
const DEADLINE_MS = 300_000;
const killer = setTimeout(() => {
  console.error("PROBE DEADLINE — exiting with partial findings");
  process.exit(2);
}, DEADLINE_MS);
killer.unref();

// Push-based input channel for a streaming-input query.
function channel() {
  const buf: SDKUserMessage[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  return {
    push(m: SDKUserMessage) {
      buf.push(m);
      wake?.();
      wake = null;
    },
    end() {
      done = true;
      wake?.();
      wake = null;
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (buf.length) yield buf.shift() as SDKUserMessage;
        if (done) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
}

const userMsg = (text: string, uuid: string): SDKUserMessage =>
  ({
    type: "user",
    uuid,
    message: { role: "user", content: [{ type: "text", text }] },
    parent_tool_use_id: null,
  }) as SDKUserMessage;

type Collected = {
  sessionId: string | null;
  lastAssistantUuid: string | null;
  resultSubtype: string | null;
  resultText: string | null;
  /** The whole result frame — (c) needs to find WHERE a refusal's text
   *  lives, so no field selection here. */
  rawResult: unknown;
  assistantText: string;
};

// Drain one turn: iterate until a `result` message, capturing what the
// measurements need. `iter` is shared across turns of one streaming query.
async function drainTurn(iter: AsyncIterator<SDKMessage>, acc: Collected): Promise<void> {
  while (true) {
    const { value: m, done } = await iter.next();
    if (done) return;
    if (m.type === "system" && m.subtype === "init") {
      acc.sessionId = (m as { session_id?: string }).session_id ?? null;
    } else if (m.type === "assistant" && !(m as { parent_tool_use_id?: string | null }).parent_tool_use_id) {
      acc.lastAssistantUuid = (m as { uuid?: string }).uuid ?? null;
      const content = (m as { message?: { content?: Array<{ type?: string; text?: string }> } })
        .message?.content;
      for (const b of content ?? []) if (b.type === "text" && b.text) acc.assistantText += b.text;
    } else if (m.type === "result") {
      acc.resultSubtype = (m as { subtype?: string }).subtype ?? null;
      acc.resultText = (m as { result?: string }).result ?? null;
      acc.rawResult = m;
      return;
    }
  }
}

// One single-shot resume turn (string prompt lane — the same headless lane the
// route uses for resumes).
async function oneShot(
  prompt: string,
  options: Record<string, unknown>,
): Promise<Collected> {
  const acc: Collected = {
    sessionId: null,
    lastAssistantUuid: null,
    resultSubtype: null,
    resultText: null,
    rawResult: null,
    assistantText: "",
  };
  const q = query({ prompt, options: { cwd, ...options } as never });
  const iter = q[Symbol.asyncIterator]();
  await drainTurn(iter, acc);
  // Drain to close cleanly (prompt_suggestion etc. may trail the result).
  void (async () => {
    try {
      while (!(await iter.next()).done) {
        /* trailing frames */
      }
    } catch {
      /* closed */
    }
  })();
  return acc;
}

// ── phase 1: two-turn streaming session with client-supplied uuids ─────────
const U1 = randomUUID();
const U2 = randomUUID();
const ch1 = channel();
const q1 = query({ prompt: ch1, options: { cwd } as never });
const iter1 = q1[Symbol.asyncIterator]();
const s1: Collected = {
  sessionId: null,
  lastAssistantUuid: null,
  resultSubtype: null,
  resultText: null,
  rawResult: null,
  assistantText: "",
};

ch1.push(userMsg("Reply with exactly: ok", U1));
await drainTurn(iter1, s1);
const A1 = s1.lastAssistantUuid;
note("session", s1.sessionId);
note("turn1.assistantUuid", A1);

// (d1) capabilities, while the stream is bidirectional.
try {
  const init = await q1.initializationResult();
  note("d.capabilities", (init as { capabilities?: unknown }).capabilities ?? "absent");
} catch (e) {
  note("d.capabilities.error", String(e));
}

ch1.push(userMsg("Remember the word 'pomegranate'. Reply with exactly: noted", U2));
await drainTurn(iter1, s1);
note("turn2.assistantUuid", s1.lastAssistantUuid);
ch1.end();
try {
  while (!(await iter1.next()).done) {
    /* drain to close */
  }
} catch {
  /* closed */
}

const S = s1.sessionId;
if (!S || !A1) {
  console.error("PROBE ABORT — no session id or assistant uuid from phase 1");
  process.exit(1);
}

// (a) uuid adoption — read the session's own JSONL back.
{
  const projects = path.join(os.homedir(), ".claude", "projects");
  let file: string | null = null;
  try {
    for (const dir of fs.readdirSync(projects)) {
      const p = path.join(projects, dir, `${S}.jsonl`);
      if (fs.existsSync(p)) {
        file = p;
        break;
      }
    }
  } catch {
    /* fall through */
  }
  if (!file) {
    note("a.uuidAdoption", "TRANSCRIPT NOT FOUND — measure by hand");
  } else {
    const uuids = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as { type?: string; uuid?: string };
        } catch {
          return {};
        }
      })
      .filter((e) => e.type === "user")
      .map((e) => e.uuid);
    note("a.userEntryUuids", uuids);
    note("a.uuidAdoption", uuids.includes(U1) && uuids.includes(U2));
  }
}

// ── phase 2 (b): truncating resume, then a plain resume of the same id ─────
const branch = await oneShot(
  "Before this message, how many messages had I sent you in this conversation? Reply with only the digit.",
  { resume: S, resumeSessionAt: A1 },
);
note("b.truncatedResume.sessionId", branch.sessionId);
note("b.truncatedResume.subtype", branch.resultSubtype);
note("b.truncatedResume.answer", branch.assistantText.trim() || branch.resultText);
note("b.truncationWorked(expect 1)", (branch.assistantText + (branch.resultText ?? "")).includes("1"));

const plain = await oneShot(
  "Have I ever asked you to remember a fruit in this conversation? Reply with exactly yes or no.",
  { resume: S },
);
note("b.plainResume.sessionId", plain.sessionId);
note("b.plainResume.answer", plain.assistantText.trim() || plain.resultText);
note(
  "b.plainResumeFollowsBranch(no=branch adopted, yes=old chain)",
  (plain.assistantText + (plain.resultText ?? "")).toLowerCase(),
);

// ── phase 3 (c): resumeDropsTurn — valid, then deliberately bogus ──────────
// A DEDICATED session: the first probe run reused S here, but phase 2's
// resumes had already appended their own turns past A1, so even the "valid"
// drop was (correctly) refused — the range contained entries not attributable
// to U2. The validator needs a chain nobody has touched since turn 2.
const U3 = randomUUID();
const U4 = randomUUID();
const ch3 = channel();
const q3 = query({ prompt: ch3, options: { cwd } as never });
const iter3 = q3[Symbol.asyncIterator]();
const s3: Collected = {
  sessionId: null,
  lastAssistantUuid: null,
  resultSubtype: null,
  resultText: null,
  rawResult: null,
  assistantText: "",
};
ch3.push(userMsg("Reply with exactly: one", U3));
await drainTurn(iter3, s3);
const C_A1 = s3.lastAssistantUuid;
ch3.push(userMsg("Reply with exactly: two", U4));
await drainTurn(iter3, s3);
ch3.end();
try {
  while (!(await iter3.next()).done) {
    /* drain to close */
  }
} catch {
  /* closed */
}
const C = s3.sessionId;
if (!C || !C_A1) {
  note("c.SKIPPED", "phase-3 session failed to start");
} else {
  const validDrop = await oneShot("Reply with exactly: ok", {
    resume: C,
    resumeSessionAt: C_A1,
    resumeDropsTurn: U4,
  });
  note("c.validDrop.subtype", validDrop.resultSubtype);
  note("c.validDrop.answer", validDrop.assistantText.trim() || validDrop.resultText);

  // The session now holds turn1 + the ok-turn; drop past C_A1 with an
  // unattributable uuid → the deterministic refusal, captured WHOLE.
  const bogusDrop = await oneShot("Reply with exactly: ok", {
    resume: C,
    resumeSessionAt: C_A1,
    resumeDropsTurn: randomUUID(),
  });
  note("c.bogusDrop.subtype", bogusDrop.resultSubtype);
  note("c.bogusDrop.rawResult", bogusDrop.rawResult);
  const rawStr = JSON.stringify(bogusDrop.rawResult ?? "");
  note("c.refusalPrefixSomewhereInFrame", rawStr.includes("Resume rejected by --resume-drops-turn:"));
}

// ── phase 4 (d receipt, e reusability): interrupt a live streaming turn ────
const ch2 = channel();
const q2 = query({ prompt: ch2, options: { cwd, includePartialMessages: true } as never });
const iter2 = q2[Symbol.asyncIterator]();
ch2.push(userMsg("Count from 1 to 300, one number per line, no commentary.", randomUUID()));

// Wait for the stream to actually start before interrupting.
let sawStream = false;
const interruptAt = Date.now() + 20_000;
while (!sawStream && Date.now() < interruptAt) {
  const { value: m, done } = await iter2.next();
  if (done) break;
  if (m.type === "stream_event" || m.type === "assistant") sawStream = true;
}
try {
  const receipt = await q2.interrupt();
  note("d.interruptReceipt", receipt ?? "undefined");
} catch (e) {
  note("d.interruptReceipt.error", String(e));
}
// The aborted turn should surface a result; drain to it (bounded).
const s2: Collected = {
  sessionId: null,
  lastAssistantUuid: null,
  resultSubtype: null,
  resultText: null,
  rawResult: null,
  assistantText: "",
};
await drainTurn(iter2, s2);
note("e.interruptedTurn.resultSubtype", s2.resultSubtype);

// (e) same query, next turn.
s2.assistantText = "";
s2.resultSubtype = null;
ch2.push(userMsg("Reply with exactly: alive", randomUUID()));
await drainTurn(iter2, s2);
note("e.postInterruptTurn.subtype", s2.resultSubtype);
note("e.postInterruptTurn.answer", s2.assistantText.trim() || s2.resultText);
note("e.runtimeReusableAfterInterrupt", /alive/i.test(s2.assistantText + (s2.resultText ?? "")));
ch2.end();
try {
  while (!(await iter2.next()).done) {
    /* drain to close */
  }
} catch {
  /* closed */
}

note("done", `probe cwd was ${cwd}`);
process.exit(0);
