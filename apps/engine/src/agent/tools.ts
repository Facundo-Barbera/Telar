/**
 * WHAT THE AGENT CAN DO — the two walls it already had, and three reads it
 * did not (#531).
 *
 * ── WHICH CAPABILITY, AND WHY NEITHER GIVES THE GATE AWAY ───────────────────
 * There are two builds of `SessionsCapability` in this engine and the issue
 * asks which one the Agent should take.
 *
 *   · `daemon.ts`'s socket build — in-process, every verb a direct `store.*`
 *     call, and NO `self` because a chat client on that socket is not a session
 *     and has nowhere to be woken.
 *   · `worker.ts`'s build — every verb back over HTTP, with `self` set to the
 *     session whose turn is running.
 *
 * THE ANSWER IS THE DAEMON'S, WITH A `self` ADDED. The Agent runs inside the
 * daemon process: routing its `sessions_list` through the daemon's own HTTP
 * surface would be a loopback and a credential for a call between two functions
 * in one process. What the worker's build has that the daemon's lacks is only
 * the `self` — so that is what is supplied here, as the reserved id `agent`.
 *
 * AND NEITHER GIVES THE REQUEST GATE FOR FREE, which is the part of the
 * question with a surprising answer. The gate a Codex or Claude turn passes
 * through is NOT on the capability at all: it is the driver's `onRequest`,
 * which is `worker.ts`'s `askEngine`, and `askEngine` is bound to a CLAIM —
 * a session, a run id and a claim token the engine can check. The Agent has
 * none of the three, because it is not a session and takes no claim. So there
 * is nothing to inherit, and inventing a synthetic claim to borrow one would be
 * a fake session existing solely to satisfy a signature. The Agent's approval
 * is therefore its own, and #531 says where it lives: `interrupt()` in the
 * graph, parked as a request on the Agent's own state rather than on a
 * session's. See `./approval.ts`.
 *
 * ── THE `self` IS `agent`, AND WHAT THAT BUYS ───────────────────────────────
 * Two things, both of which a capability with no `self` refuses in words:
 * SUBSCRIPTIONS (`sessions_subscribe` needs somebody to wake) and ATTRIBUTION
 * (a turn the Agent sends is stamped as coming from it). It is a RESERVED id
 * rather than a session id — nothing in `sessions/` goes by it, `sessions_read`
 * on it answers not-found, and the store's subscription verbs know it by name.
 *
 * ── AND NOTHING ELSE ────────────────────────────────────────────────────────
 * No shell, no browser, no files, no notebooks-as-documents, no ds, no latex,
 * no run, no display. Not disabled — ABSENT, which is `main-session/driver.ts`'s
 * rule and the right one: a model with no such tool says so, where a model whose
 * tool is refused reports the refusal as a fault.
 */
import { z } from "zod";
import { collectTools, toolInputSchema, type SocketTool } from "../mcp-socket";
import { notesTools, type NotesCapability } from "../notes-tools/tools";
import { sessionsTools, type SessionsCapability } from "../sessions-tools/tools";
import { err, failure, json, type ToolFactory } from "../tool-kit";
import { SECTION_CHARS, STANDING_SECTION_KEYS, type StandingSection } from "./memory";
import type { AgentRecallHit } from "./thread-log";

export { AGENT_SELF_ID } from "./identity";

/* ------------------------------------------------------------------ *
 * The three query tools — #516's reads, with the Agent as their first user.
 * ------------------------------------------------------------------ */

/**
 * The store methods behind `sessions_find`, `sessions_outline` and
 * `sessions_answer`, as a capability rather than a store handle — the seam
 * every other wall in this engine uses, so a test drives these three with three
 * functions and no daemon.
 */
export type AgentQueryCapability = {
  find(query: { q: string; projectId?: string; settled?: boolean; since?: number; limit: number }): Promise<{
    sessions: Array<{ id: string; title?: string; projectId?: string; activity: string; updatedAt: number; runId?: string; why: string }>;
    index: string;
    more: boolean;
  }>;
  outline(sessionId: string, window: { limit: number; before?: number }): Promise<{ turns: unknown[]; total: number; more: boolean; next?: number }>;
  answer(sessionId: string, options: { runId?: string; from: number; limit: number }): Promise<{
    runId: string;
    sequence: number;
    text: string;
    from: number;
    totalChars: number;
    more: boolean;
    next?: number;
  }>;
};

/**
 * THE SAME CEILINGS THE ROUTES APPLY, and deliberately the same numbers rather
 * than a second opinion — `daemon.ts`'s query-route block is where they are
 * argued for. A tool answer is a context window spent (#515), so these are
 * clamps and not suggestions: asking for more is served less, and the answer
 * says so.
 */
const FIND_LIMIT_DEFAULT = 10;
const FIND_LIMIT_MAX = 50;
const OUTLINE_PAGE_DEFAULT = 20;
const OUTLINE_PAGE_MAX = 100;
const ANSWER_SLICE_DEFAULT = 8_000;
const ANSWER_SLICE_MAX = 64_000;

const FIND =
  "Which conversation was this — a lexical search over every session, each hit carrying the line that matched. " +
  "The cheap first step before sessions_read.";

const OUTLINE =
  "Scroll a conversation without reading it: one row per turn, newest first — what was asked, what it did, how it ended.";

const ANSWER =
  "What one turn concluded — the answer alone, without its events. Defaults to the latest turn that said something.";

export function agentQueryTools(tool: ToolFactory, capability: AgentQueryCapability): unknown[] {
  return [
    tool(
      "sessions_find",
      FIND,
      {
        q: z.string().min(1).describe("Lexical, not semantic — the phrase you remember seeing."),
        projectId: z.string().min(1).optional(),
        settled: z.boolean().optional().describe("true for shelved only, false for open. Omit for both."),
        since: z.number().int().min(0).optional().describe("Epoch milliseconds."),
        limit: z.number().int().min(1).max(FIND_LIMIT_MAX).optional().describe(`Default ${FIND_LIMIT_DEFAULT}.`),
      },
      async (args) => {
        try {
          const found = await capability.find({
            q: String(args.q ?? ""),
            ...(typeof args.projectId === "string" && args.projectId ? { projectId: args.projectId } : {}),
            ...(typeof args.settled === "boolean" ? { settled: args.settled } : {}),
            ...(typeof args.since === "number" ? { since: args.since } : {}),
            limit: clamp(args.limit, FIND_LIMIT_DEFAULT, FIND_LIMIT_MAX),
          });
          return json({
            ...found,
            // WHICH INDEX ANSWERED, carried through from the store. A caller
            // comparing two engines' results deserves to know whether it got
            // FTS5 or the bounded scan.
            note: found.more ? "More sessions matched than are shown. Narrow with projectId, settled or since rather than raising the limit." : undefined,
          });
        } catch (error) {
          return err(`Could not search: ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_outline",
      OUTLINE,
      {
        sessionId: z.string().min(1),
        before: z.number().int().min(0).optional().describe("The `next` a previous page returned, so appends cannot shift the window."),
        limit: z.number().int().min(1).max(OUTLINE_PAGE_MAX).optional().describe(`Default ${OUTLINE_PAGE_DEFAULT}.`),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        try {
          return json(
            await capability.outline(sessionId, {
              limit: clamp(args.limit, OUTLINE_PAGE_DEFAULT, OUTLINE_PAGE_MAX),
              ...(typeof args.before === "number" ? { before: args.before } : {}),
            }),
          );
        } catch (error) {
          return err(`Could not outline "${sessionId}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "sessions_answer",
      ANSWER,
      {
        sessionId: z.string().min(1),
        runId: z.string().min(1).optional().describe("Omit for the latest turn that left text — the usual case after a wake."),
        from: z.number().int().min(0).optional().describe("Character offset; the reply says the total."),
        limit: z.number().int().min(1).max(ANSWER_SLICE_MAX).optional().describe(`Default ${ANSWER_SLICE_DEFAULT}.`),
      },
      async (args) => {
        const sessionId = String(args.sessionId ?? "");
        try {
          return json(
            await capability.answer(sessionId, {
              ...(typeof args.runId === "string" && args.runId ? { runId: args.runId } : {}),
              from: typeof args.from === "number" ? Math.max(0, args.from) : 0,
              limit: clamp(args.limit, ANSWER_SLICE_DEFAULT, ANSWER_SLICE_MAX),
            }),
          );
        } catch (error) {
          return err(`Could not read the answer from "${sessionId}": ${failure(error)}`);
        }
      },
    ),
  ];
}

/** A caller's number, or the default, never above the ceiling. Clamped rather
 *  than refused, because a model that asked for 500 wants as many as it can
 *  have and the answer says what it got. */
function clamp(raw: unknown, fallback: number, ceiling: number): number {
  if (typeof raw !== "number" || !Number.isSafeInteger(raw) || raw < 1) return fallback;
  return Math.min(raw, ceiling);
}

/* ------------------------------------------------------------------ *
 * The Agent's own memory — #541 part F.
 * ------------------------------------------------------------------ */

/**
 * The two verbs the Agent has about ITSELF, as a capability for the same reason
 * every other one here is: the runtime owns the document and the transcript,
 * and a test drives these two with two functions and no graph.
 */
export type AgentMemoryCapability = {
  /** Replace one section of the standing document. Empty text clears it. */
  remember(section: StandingSection, text: string): { sections: Partial<Record<StandingSection, string>> };
  /** Search this thread's own rows. */
  recall(query: string, limit: number): AgentRecallHit[];
};

const RECALL_LIMIT_DEFAULT = 8;
const RECALL_LIMIT_MAX = 25;

const REMEMBER =
  "Rewrite one section of what you hold across turns. It is always in your prompt and never in the conversation, so it " +
  "survives older turns being folded away. One section at a time — the other three are untouched. Empty text clears a section.";

const RECALL =
  "Search THIS conversation's own history — what you and the person said, and what your tools answered — including turns " +
  "already folded out of your prompt. Newest first, each hit quoting the line that matched.";

export function agentMemoryTools(tool: ToolFactory, capability: AgentMemoryCapability): unknown[] {
  return [
    tool(
      "remember",
      REMEMBER,
      {
        section: z
          .enum(STANDING_SECTION_KEYS as [StandingSection, ...StandingSection[]])
          .describe("doing: what you are working on. who: which session is on what. questions: what you are waiting to hear. preferences: how this person wants to be worked with."),
        text: z.string().describe(`The section's whole new text — it REPLACES what was there. Clipped at ${SECTION_CHARS} characters.`),
      },
      async (args) => {
        try {
          const state = capability.remember(args.section as StandingSection, typeof args.text === "string" ? args.text : "");
          return json({ sections: state.sections, note: "Rewritten. It is in your prompt from the next lap onwards." });
        } catch (error) {
          return err(`Could not remember that: ${failure(error)}`);
        }
      },
    ),
    tool(
      "recall",
      RECALL,
      {
        q: z.string().min(1).describe("Lexical, not semantic — the phrase you remember seeing."),
        limit: z.number().int().min(1).max(RECALL_LIMIT_MAX).optional().describe(`Default ${RECALL_LIMIT_DEFAULT}.`),
      },
      async (args) => {
        try {
          const hits = capability.recall(String(args.q ?? ""), clamp(args.limit, RECALL_LIMIT_DEFAULT, RECALL_LIMIT_MAX));
          return json({
            hits,
            ...(hits.length === 0 ? { note: "Nothing in this conversation matched. It is lexical — try the words you actually used." } : {}),
          });
        } catch (error) {
          return err(`Could not recall that: ${failure(error)}`);
        }
      },
    ),
  ];
}

/* ------------------------------------------------------------------ *
 * The wall.
 * ------------------------------------------------------------------ */

export type AgentWalls = {
  sessions: SessionsCapability;
  notes: NotesCapability;
  query: AgentQueryCapability;
  /** The Agent's own standing state and history search. Absent in a test that
   *  is only asking what the two shared walls hold. */
  memory?: AgentMemoryCapability;
};

/**
 * The Agent's whole tool list: 13 sessions tools, 3 query tools, 5 notes tools,
 * and the two it has about itself.
 *
 * SESSIONS FIRST, then the queries beside them, then the notebook — the order a
 * model is shown them in, and it is deliberate: the sessions wall is what the
 * Agent is FOR, and a read that narrows the rail belongs next to the one that
 * lists it. Its own memory is last, because it is the only pair that is about
 * the Agent rather than about Telar's work.
 */
export function collectAgentTools(walls: AgentWalls): SocketTool[] {
  return [
    ...collectTools(sessionsTools as never, walls.sessions as never),
    ...collectTools(agentQueryTools as never, walls.query as never),
    ...collectTools(notesTools as never, walls.notes as never),
    ...(walls.memory ? collectTools(agentMemoryTools as never, walls.memory as never) : []),
  ];
}

/**
 * ONE FUNCTION DEFINITION PER TOOL, AS THE MODEL IS BOUND TO THEM.
 *
 * ── WHAT IS DROPPED, AND WHY ONLY HERE (#563) ───────────────────────────────
 * `z.toJSONSchema` writes for a VALIDATOR. Three of the things it writes mean
 * nothing to a language model and are resent on every lap of every turn:
 *
 *   · `"$schema": "https://json-schema.org/draft/2020-12/schema"` — 56
 *     characters naming a dialect version nobody here is checking, ×21 tools.
 *   · `"maximum": 9007199254740991` — what `z.number().int()` emits, which is
 *     "an integer" said in 26 characters.
 *   · `"minLength": 1` and `"propertyNames"` — a required string is required
 *     and a record's keys are strings.
 *
 * THE MCP SOCKET KEEPS ALL OF IT. `tools/list` answers programs that may well
 * validate, `toolInputSchema` is what that route serves, and one lap of one
 * Agent turn is not a reason to narrow a wire format other software reads. This
 * is the Agent's own binding, so the narrowing lives in it.
 *
 * NOTHING THE MODEL CHOOSES FROM IS TOUCHED: names, types, enums, real bounds
 * and `required` all go through exactly as they were.
 */
export function agentToolSpecs(tools: readonly SocketTool[]): Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }> {
  return tools.map((tool) => ({
    type: "function" as const,
    function: { name: tool.name, description: tool.description, parameters: forModel(toolInputSchema(tool.shape)) as Record<string, unknown> },
  }));
}

/** The validator's bookkeeping removed, everything a model reads kept. */
function forModel(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(forModel);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$schema" || key === "minLength" || key === "propertyNames") continue;
    // A safe-integer bound is zod saying "whole number", not a limit anybody set.
    if ((key === "maximum" || key === "minimum") && typeof value === "number" && Math.abs(value) === Number.MAX_SAFE_INTEGER) continue;
    out[key] = forModel(value);
  }
  return out;
}
