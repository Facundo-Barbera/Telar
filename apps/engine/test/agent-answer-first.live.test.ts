/**
 * DOES THE PARAGRAPH ACTUALLY CHANGE THE CHOICE — off unless asked for (#601).
 *
 * ── WHY THIS CANNOT BE A SCRIPTED TEST ──────────────────────────────────────
 * Every other thing the briefing promises is pinned by string assertions in
 * `agent-briefing.test.ts`, and every path it relies on is pinned against a
 * scripted model in `agent-runtime.test.ts` — which, as that file says in its own
 * header, "proves the PATHS, never that a real model chooses them". #601 is
 * entirely about which path a real model chooses: the news was already in the
 * prompt and it went asking anyway. A fake model cannot fail that way, so a fake
 * model cannot prove it fixed.
 *
 * ── SO THIS ASKS A REAL ONE, AND IT IS GATED SEPARATELY ─────────────────────
 * `TELAR_LIVE_BRIEFING=1`, and deliberately NOT `agent.live.test.ts`'s
 * `TELAR_LIVE_SMOKE`. That file answers "does the real endpoint accept what this
 * build sends" and states a three-call budget; this answers a different question
 * with a different cost, and the moment you want it is different too — a provider
 * smoke runs when the wire format moves, this runs when somebody edits the
 * paragraph. Sharing a flag would make each one's budget the other's problem.
 *
 * ── IT IS EVIDENCE, NOT A GATE ──────────────────────────────────────────────
 * A model's choice is stochastic and this suite never runs in CI. What it buys
 * is the one measurement the issue was filed on — the owner's 119 turns, where a
 * greeting cost the same pile of reads as a real status question — repeatable in
 * four calls before and after a prompt edit. Read the printed rows; they say
 * WHICH tools were reached for, which is what makes a regression legible.
 *
 * ── AND IT TESTS BOTH DIRECTIONS, WHICH IS THE WHOLE POINT ──────────────────
 * The issue is explicit that the fix must not be a cap: "a hard cap would
 * produce confident answers built on nothing when a question genuinely needs a
 * read". So the exception is measured beside the default, and a build that
 * answered EVERYTHING with no call would fail here just as loudly as the one
 * that looked before every answer.
 */
import { describe, expect, test } from "bun:test";
import path from "node:path";
import { AIMessage, HumanMessage, SystemMessage } from "@langchain/core/messages";
import { AGENT_BRIEFING } from "../src/agent/briefing";
import { renderDigest } from "../src/agent/digest";
import { describeGoCredential, resolveGoCredential } from "../src/agent/credentials";
import { agentChatModel } from "../src/agent/model";
import { agentToolSpecs, collectAgentTools, type AgentFleetCapability, type AgentQueryCapability } from "../src/agent/tools";
import { AGENT_SELF_ID } from "../src/agent/identity";
import type { AgentInboxRow } from "../src/agent/inbox";
import type { NotesCapability } from "../src/notes-tools/tools";
import type { SessionsCapability } from "../src/sessions-tools/tools";
import type { Session, Turn } from "@telar/engine-client";

const LIVE = process.env.TELAR_LIVE_BRIEFING === "1";

const THREAD = "thread_telar_briefing_probe";
const agentDir = process.env.TELAR_HOME ? path.join(process.env.TELAR_HOME, "engine", "agent") : undefined;

/**
 * THE WALLS, AS STUBS. Nothing here is ever CALLED — the probe reads whether the
 * model asked for a tool, never what one would have answered. They exist so the
 * binding the model sees is the real one, descriptions and schemas included,
 * since those descriptions are half of where #601's rule now lives.
 */
const stubSessions = (): SessionsCapability => ({
  self: { sessionId: AGENT_SELF_ID },
  list: async () => ({ sessions: [], projects: [] }),
  create: async () => ({}) as Session,
  send: async () => ({ turn: {} as Turn, replayed: false }),
  read: async () => [],
  status: async () => ({ session: {} as Session, turns: [] }),
  stop: async () => ({ stopped: 0 }) as never,
  settle: async () => ({}) as Session,
  diff: async () => ({}) as never,
  subscribe: async () => ({}) as never,
  unsubscribe: async () => false,
  subscriptions: async () => [],
  requests: async () => [],
  resolveRequest: async () => ({}) as never,
});

const stubNotes = (): NotesCapability => ({
  projects: async () => [],
  list: async () => [],
  read: async () => null,
  create: async () => ({}) as never,
  update: async () => null,
  remove: async () => false,
});

const stubQueries = (): AgentQueryCapability => ({
  find: async () => ({ sessions: [], index: "like", more: false }),
  outline: async () => ({ turns: [], total: 0, more: false }),
  answer: async () => ({ runId: "run_1", sequence: 1, text: "", from: 0, totalChars: 0, more: false }),
});

const stubFleet = (): AgentFleetCapability => ({
  rail: async () => ({ sessions: [], projects: [] }),
  subscribed: async () => [],
  who: () => undefined,
  session: async () => undefined,
  lastTurn: async () => undefined,
  openRequests: async () => 0,
  unread: () => ({}),
  since: () => undefined,
});

let nextId = 1;
const inboxRow = (kind: AgentInboxRow["kind"], sessionId: string, summary: string): AgentInboxRow => ({
  id: nextId++,
  at: 1_000 + nextId,
  sessionId,
  runId: `run_${nextId}`,
  kind,
  summary,
  read: false,
});

/**
 * THE NEWS THE OWNER'S TURNS ACTUALLY CARRIED — one finished, one failed with
 * its reason, one waiting on him. Enough that a check-in has a real answer in
 * front of it, which is the condition #601 is about: the Agent is not being
 * asked to invent anything, only to read what it was handed.
 */
const DIGEST = renderDigest([
  inboxRow("turn_completed", "session_migrations", "[wake: completed] Session — the schema migration landed and CI is green."),
  inboxRow("turn_failed", "session_billing", "[wake: failed] Session — turn FAILED (ran out of context on the invoice fixture)."),
  inboxRow("request_opened", "session_deploy", "[wake: waiting] Session — is WAITING on a request: promote to production?"),
])!.text;

/**
 * WHAT THE AGENT REMEMBERS, because the rule names BOTH halves of the prompt and
 * a probe that supplied only the digest would be testing half the sentence. This
 * is the shape `renderStanding` writes, and the "who is on what" section is the
 * one that carries in-flight work the digest structurally cannot — see
 * `briefing.ts`'s #601 section.
 */
const STANDING = [
  "[What you are holding across turns]",
  "doing: shepherding the billing rewrite across three sessions.",
  "who: session_migrations is on the schema, session_billing is on invoices, session_deploy is waiting to promote.",
  "questions: whether the owner wants the invoice fixture split before retrying.",
  "preferences: short answers; Spanish back to Spanish.",
].join("\n");

type Probe = { label: string; question: string; expectLook: boolean; why: string };

/**
 * THE FOUR, AND EACH ONE IS A TURN FROM THE MEASURED LOG.
 *
 * The first three are the ones the issue says must cost nothing — a greeting, a
 * check-in, and a question about a fact the digest spells out in so many words.
 * The fourth is the exception, and it is here so that "zero calls" cannot be
 * bought by a model that simply stopped reading: the digest names that the
 * billing turn failed, but NOT what it said, and only a read can get that.
 */
const PROBES: Probe[] = [
  { label: "greeting", question: "¿Estás ahí?", expectLook: false, why: "a greeting is about this conversation and nothing else" },
  { label: "check-in", question: "¿cómo vamos?", expectLook: false, why: "the digest and the notes together are the answer" },
  {
    label: "digest fact",
    question: "¿Alguna sesión está esperando algo de mí?",
    expectLook: false,
    why: "the digest's first band is literally WAITING ON YOU",
  },
  {
    label: "one turn's words",
    question: "¿Qué dijo exactamente session_billing en su último turno? Quiero el texto.",
    expectLook: true,
    why: "the digest carries the failure's reason, never the turn's words",
  },
];

describe.skipIf(!LIVE)("the briefing's answer-before-you-look rule, against a real model", () => {
  const credential = resolveGoCredential({ ...(agentDir ? { agentDir } : {}) });
  const tools = agentToolSpecs(collectAgentTools({ sessions: stubSessions(), notes: stubNotes(), query: stubQueries(), fleet: stubFleet() }));

  /** The system block exactly as `buildGraph` assembles it: briefing, standing
   *  state, then the digest. The order is load-bearing and is asserted below. */
  const system = new SystemMessage([AGENT_BRIEFING, STANDING, DIGEST].join("\n\n"));

  test("the probe is built from the real paragraph and the real digest", () => {
    expect(credential, "no OpenCode Go key on any rung — paste one in Settings or export OPENCODE_API_KEY").toBeDefined();
    const text = String(system.content);
    expect(text).toContain("ANSWER BEFORE YOU LOOK");
    expect(text).toContain("what happened since your last turn");
    expect(text).toContain("WAITING ON YOU");
    // The rule above the news, which is what makes the news readable as news.
    expect(text.indexOf("ANSWER BEFORE YOU LOOK")).toBeLessThan(text.indexOf("what happened since your last turn"));
    // And the tools are the real binding, descriptions included — half of #601's
    // rule lives in `fleet_status`'s own description.
    expect(tools.find((each) => each.function.name === "fleet_status")?.function.description).toContain("NOT to confirm the digest");
  });

  test("a question the prompt answers takes no tool call, and one it does not still reads", async () => {
    if (!credential) return;
    const model = agentChatModel({
      threadId: THREAD,
      ...(agentDir ? { agentDir } : {}),
      streaming: false,
      // Room for a short answer or a tool call. A ceiling of 1 would make every
      // row report `max_tokens` and prove nothing about the choice.
      maxTokens: 256,
    });
    const withTools = model.bindTools!(tools);

    const rows: Array<{ probe: Probe; called: string[] }> = [];
    // SEQUENTIAL. Four concurrent completions against one key is a rate-limit
    // report dressed up as a finding.
    for (const probe of PROBES) {
      const answer = (await withTools.invoke([system, new HumanMessage(probe.question)])) as AIMessage;
      rows.push({ probe, called: (answer.tool_calls ?? []).map((call) => call.name) });
    }

    for (const { probe, called } of rows) {
      const verdict = probe.expectLook === called.length > 0 ? "ok" : "UNEXPECTED";
      console.log(
        `[briefing] ${probe.label.padEnd(16)} → ${called.length} call${called.length === 1 ? "" : "s"}${called.length ? ` (${called.join(", ")})` : ""} — expected ${probe.expectLook ? "a read" : "none"}, ${verdict}`,
      );
    }

    // THE DEFAULT: the three the prompt already answers cost nothing.
    const looked = rows.filter((row) => !row.probe.expectLook && row.called.length > 0);
    expect(
      looked.map((row) => `${row.probe.label}: reached for ${row.called.join(", ")} — ${row.probe.why}`),
      "these are answerable from the digest and the notes; a call here is #601 regressing",
    ).toEqual([]);

    // AND THE EXCEPTION, measured in the same breath so a build cannot pass by
    // refusing to look at anything.
    const blind = rows.filter((row) => row.probe.expectLook && row.called.length === 0);
    expect(
      blind.map((row) => `${row.probe.label}: answered with no read — ${row.probe.why}`),
      "the exception must survive: this one cannot be answered from the prompt",
    ).toEqual([]);
  });
});
