// THE MASTER CHAT'S TURN STATE, AS DATA (story 5.7, SPEC-organization-workspace
// CAP-1/CAP-3).
//
// The master surface is an OWNER ADAPTER on the shared `Conversation` shell
// (AD-12): the shell owns rendering, the adapter owns session semantics. This
// module is the adapter's session semantics with the React taken out — a wire
// payload builder, a seed, and a total reducer over the SSE frames
// `POST /api/chat` emits. components/workspace/master-chat.tsx holds the
// effects, the fetch and the registry; everything decidable without a DOM is
// decided here, where a bun test can drive it.
//
// NO "use client" AND NO RUNTIME IMPORT FROM components/conversation, for the
// same reason items.ts states for itself: this file is pure data + pure
// functions, and every import below is `import type`, which erases. The shell's
// runtime values (`CONVERSATION_KINDS`, `groupParts`, `toTranscriptItems`)
// belong to the component that renders, not to the module that reduces.
//
// A REDUCED APPLY, AND THE REDUCTION IS NAMED. session-view.tsx's
// `applyServerEvent` is the full one; the dock's `applyLiveEvent` is the other
// reduced one, and it set this precedent. What this one drops, deliberately:
//   · SUB-AGENT FRAMES (`payload.parent`) — the master's tool policy mounts the
//     workspace server and the read triad and nothing else, so nothing it can
//     call spawns. AN EARLIER NOTE HERE PREDICTED story 8's per-project experts
//     would be the first parented frames. THEY ARE NOT, and deliberately: a
//     harness sub-agent inherits its caller's project, and SPEC.md inverts that
//     ("the master has NO project and each expert it calls is scoped to its
//     own"), so an expert is an `agent()` call spawned in-process by
//     consult_expert — the same channel Ultra's children never reach. It
//     surfaces as one tool frame, not as a parented sub-tree. Nothing in the
//     master's surface produces a `parent` today; a parented frame remains
//     silently main-thread-free, not mis-filed.
//   · ULTRA ANCHORS — ui-contract.md §1: "No Ultra chip here — ultra's mutating
//     tools dereference a project, which the master lacks." The server does not
//     mount the server; the client does not render its anchors.
//   · ROLLBACK, QUEUEING, COMPACTION DIVIDERS, TITLE RENAME — session chrome the
//     master surface does not offer.
// Everything a master turn can actually produce — text, thinking, tool calls and
// their results, permission cards, markers, the error and the close — is here.

import type { AttachmentRef, ChatMessage, Part, StoreMessage } from "@/components/conversation";

/** The session role this surface puts on the wire. The route's
 *  `sessionRoleFromWire` narrows to this exact string; anything else collapses
 *  to `undefined` and anchors as a project session, which for a project-less
 *  turn is a 400. One literal, one definition site. */
export const MASTER_SESSION_ROLE = "master" as const;

export type MasterStatus = "ready" | "submitted" | "streaming" | "error";

export type MasterChatState = {
  /** The harness session id, adopted from the `session` frame. `null` until the
   *  first turn names one. Never written into the address bar: this surface
   *  keeps its own route (the steerer/escalation precedent), so a reload lands
   *  on the master's front door and resumes from the store. */
  sessionId: string | null;
  messages: ChatMessage[];
  status: MasterStatus;
  /** The harness is in a thinking block — drives the composer's shimmer wording
   *  and nothing else. */
  thinking: boolean;
};

export const INITIAL_MASTER_STATE: MasterChatState = {
  sessionId: null,
  messages: [],
  status: "ready",
  thinking: false,
};

// ── the wire ────────────────────────────────────────────────────────────────

export type MasterTurnPayload = {
  message: string;
  runId: string;
  role: typeof MASTER_SESSION_ROLE;
  sessionId?: string;
  model?: string;
  account?: string;
  /** Ids minted by POST /api/chat/attachments, which already holds the bytes.
   *  METADATA ONLY on this wire — the route resolves each id to an absolute
   *  path and hands the harness the path, never the bytes (AD: lib/
   *  attachment-contract.ts). Absent when the turn carried nothing. */
  attachments?: AttachmentRef[];
};

/**
 * The body of a master turn.
 *
 * THE ABSENT KEY IS THE POINT. There is no `project` field — not `undefined`,
 * not `""`, ABSENT — because the route's anchor block is what makes this
 * session project-less: `resolveSessionAnchor({ kind: "master" })` never reads
 * the wire's project, and story 5.6's own review found that a master request
 * carrying a project name ran the master WITH that project's manifest, MCP
 * servers and permissions bucket. The route shadows the field defensively;
 * this builder never spells it, and master-chat.test.ts asserts the key is
 * missing rather than falsy.
 *
 * `role` rides EVERY turn, not just the first. A resumed master is anchored
 * from the persisted `Chat.role` when the wire omits it — but that fallback
 * exists for clients that cannot re-send it, and relying on a fallback the
 * store has to remember is how a resumed master 400s the day a row is written
 * without one.
 */
export function masterTurnPayload(input: {
  message: string;
  runId: string;
  sessionId?: string | null;
  model?: string;
  account?: string;
  attachments?: readonly AttachmentRef[];
}): MasterTurnPayload {
  return {
    message: input.message,
    runId: input.runId,
    role: MASTER_SESSION_ROLE,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    ...(input.model ? { model: input.model } : {}),
    ...(input.account ? { account: input.account } : {}),
    ...(input.attachments?.length ? { attachments: [...input.attachments] } : {}),
  };
}

// ── the seed ────────────────────────────────────────────────────────────────

/**
 * The persisted transcript, projected into the shell's live message shape —
 * session-view.tsx's `seedMessages` for the parts a master turn can produce.
 * Persisted parts are always finished, so every `done` is true.
 *
 * A permission part is NOT seeded back as pending: a card whose stream is gone
 * can never be answered, and rendering a live-looking one would invite a click
 * that goes nowhere. It reloads as the marker line the route persisted, or not
 * at all.
 *
 * ATTACHMENTS DO come back, and that changed with the composer: the master
 * takes pasted and dropped files, so a reload that dropped their chips would
 * show a turn whose text refers to a screenshot the transcript no longer
 * mentions. The shell renders them through its own built-in `attachments` kind,
 * tombstone included once the bytes are collected.
 */
export function seedMasterMessages(messages: readonly StoreMessage[]): ChatMessage[] {
  return messages.map((m, i) => ({
    id: `seed-${i}`,
    role: m.role,
    parts: m.parts.flatMap((p): Part[] => {
      if (p.type === "text") {
        return [{ type: "text", text: p.text, done: true, ...(p.parentId ? { parentId: p.parentId } : {}) }];
      }
      if (p.type === "marker") {
        return [
          {
            type: "marker",
            text: p.text,
            ...(p.attention ? { attention: true } : {}),
            ...(p.agentId ? { agentId: p.agentId } : {}),
          },
        ];
      }
      if (p.type === "tool") {
        // EVERY FIELD THE ROW CAN DRAW, CARRIED (5.7's review). Rebuilding a
        // tool part by hand is how a reload quietly loses a badge: `autoDenied`
        // is the reachable one here — the master's profile allows only the read
        // triad and the workspace server, so anything else it reaches for is
        // hard-blocked, and dropping the flag would reload that refusal as an
        // ordinary step with no output. `agent`/`taskStatus` are story 8's
        // experts, carried now so that story does not have to remember to.
        return [
          {
            type: "tool",
            name: p.name,
            id: p.id,
            input: p.input,
            output: p.output,
            isError: p.isError,
            interrupted: p.interrupted,
            ...(p.parentId ? { parentId: p.parentId } : {}),
            ...(p.agent ? { agent: p.agent } : {}),
            ...(p.taskStatus ? { taskStatus: p.taskStatus } : {}),
            ...(p.autoDenied ? { autoDenied: true } : {}),
          },
        ];
      }
      if (p.type === "attachments") {
        return [{ type: "attachments", files: p.files }];
      }
      return [];
    }),
  }));
}

// ── the turn ────────────────────────────────────────────────────────────────

/** Opens a turn: the user's bubble and the empty assistant bubble the stream
 *  fills. Ids come from the caller (crypto.randomUUID in the component) so a
 *  React key is stable for the life of the message. */
export function beginMasterTurn(
  state: MasterChatState,
  turn: { userId: string; assistantId: string; text: string },
): MasterChatState {
  return {
    ...state,
    status: "submitted",
    thinking: false,
    messages: [
      ...state.messages,
      {
        id: turn.userId,
        role: "user",
        parts: [{ type: "text", text: turn.text, done: true }],
      },
      { id: turn.assistantId, role: "assistant", parts: [] },
    ],
  };
}

/**
 * The turn ended. `error` renders as an attention marker in the transcript —
 * the Marker primitive's voice, in the position the failure happened — rather
 * than as chrome above the conversation, because a failed turn is part of the
 * history the next turn is read against.
 *
 * A TURN THAT ALREADY FAILED STAYS FAILED. The route emits `error` MID-STREAM
 * for a guardrail refusal and then closes normally, so the teardown that runs
 * in the component's `finally` arrives with no error of its own — and a
 * blanket reset to "ready" would erase the status the frame just set while its
 * marker stayed on screen, leaving the composer claiming a clean turn under a
 * red line. The status is only cleared by a turn that did not fail.
 *
 * AND IT CLOSES THE STREAM'S OWN LOOSE ENDS, WHICH IS THE HALF A `done` FRAME
 * CANNOT BE TRUSTED TO DO (5.7's review). This function runs in the component's
 * `finally`, so it is the ONE thing that runs on every exit — a clean close, a
 * Stop, a dropped connection, a server crash, a JSON.parse throw inside
 * consumeSSE. On the last four the server's teardown fail-closed-denies every
 * permission still open on the stream and flags every unresolved call, and its
 * `permission_result`/`interrupted` frames are precisely the frames a dead
 * stream cannot deliver. So both are mirrored HERE:
 *
 *   · A PENDING CARD BECOMES DENIED. Left pending it keeps rendering live
 *     Allow/Deny for a turn that is already over server-side, and answering it
 *     POSTs to an id nobody holds — a card that then reads "Allowed" for a tool
 *     call that was never approved and never ran. On the one surface whose job
 *     is to put the accept moat on screen, that is the worst lie available.
 *   · AN UNANSWERED CALL BECOMES INTERRUPTED. Without it a killed call renders
 *     as a COMPLETED step whose body reads "(no output)" instead of
 *     "(interrupted before finishing)" — the transcript claiming a tool
 *     finished when it was cut off.
 *
 * Both are safe on a CLEAN close too, and that is not a coincidence: once this
 * stream is over, a pending card can never be answered and a call with no
 * output can never get one. session-view.tsx:2666-2682 is the precedent for
 * both, on its own catch path.
 */
export function endMasterTurn(
  state: MasterChatState,
  outcome?: { error?: string | null },
): MasterChatState {
  const settled = settleOpenTurn(state);
  const error = outcome?.error?.trim();
  if (!error) {
    return { ...settled, status: settled.status === "error" ? "error" : "ready", thinking: false };
  }
  return {
    ...appendPart(settled, { type: "marker", text: error, attention: true }),
    status: "error",
    thinking: false,
  };
}

// Every message, not just the trailing bubble: a tool_use id is globally unique
// and a call can outlive the bubble that opened it (see `tool_result`), so the
// same reach is the right one for closing one out.
function settleOpenTurn(state: MasterChatState): MasterChatState {
  return {
    ...state,
    messages: state.messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => {
        if (p.type === "permission" && p.status === "pending") {
          return { ...p, status: "denied" as const };
        }
        if (p.type === "tool" && p.output === undefined && p.interrupted !== true) {
          return { ...p, interrupted: true };
        }
        return p;
      }),
    })),
  };
}

/**
 * The turn's own attachments, chipped onto the user's bubble.
 *
 * PATCHED IN RATHER THAN INCLUDED AT `beginMasterTurn`: the ids do not exist
 * until the upload returns, and holding the whole bubble behind that upload
 * would make the composer feel like it swallowed the message (session-view's
 * `send` makes the same trade for the same reason). The text lands instantly;
 * the chips follow. A turn with no files is returned untouched.
 */
export function attachToMasterTurn(
  state: MasterChatState,
  userId: string,
  files: readonly AttachmentRef[],
): MasterChatState {
  if (!files.length) return state;
  return {
    ...state,
    messages: state.messages.map((m) =>
      m.id === userId
        ? { ...m, parts: [...m.parts, { type: "attachments", files: [...files] }] }
        : m,
    ),
  };
}

// The trailing assistant bubble, or a fresh one when the last message is the
// user's (a frame that arrives outside a turn this client opened). The derived
// id is unique because `messages` only ever appends.
function appendPart(state: MasterChatState, part: Part): MasterChatState {
  return patchAssistant(state, (m) => ({ ...m, parts: [...m.parts, part] }));
}

function patchAssistant(
  state: MasterChatState,
  fn: (m: ChatMessage) => ChatMessage,
): MasterChatState {
  const last = state.messages[state.messages.length - 1];
  if (last?.role === "assistant") {
    return {
      ...state,
      messages: [...state.messages.slice(0, -1), fn(last)],
    };
  }
  const opened: ChatMessage = {
    id: `master-${state.messages.length}`,
    role: "assistant",
    parts: [],
  };
  return { ...state, messages: [...state.messages, fn(opened)] };
}

// A thinking block is closed by whatever follows it. AT MOST ONE open thinking
// part at any moment, by construction rather than by luck — Codex emits two
// block starts back to back with nothing in between.
function closeThinking(m: ChatMessage): ChatMessage {
  let touched = false;
  const parts = m.parts.map((p) => {
    if (p.type === "thinking" && !p.done) {
      touched = true;
      return { ...p, done: true };
    }
    return p;
  });
  return touched ? { ...m, parts } : m;
}

// Merge into the trailing OPEN part of `type`, or open one. The master has no
// sub-agent frames (see the header), so "trailing" needs no parent scoping.
function mergeText(
  m: ChatMessage,
  type: "text" | "thinking",
  text: string,
  done: boolean,
): ChatMessage {
  const last = m.parts[m.parts.length - 1];
  if (last && last.type === type && !last.done) {
    const parts = [...m.parts];
    parts[parts.length - 1] = done
      ? { type, text, done: true }
      : { type, text: last.text + text, done: false };
    return { ...m, parts };
  }
  return { ...m, parts: [...m.parts, { type, text, done }] };
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

// FRAMES THAT BELONG TO THE TURN, NOT TO A THREAD IN IT. The `parent` guard
// below drops CONTENT frames that came from a sub-agent, because appending a
// spawn's words to the master's own reply would be a lie about who said it.
// These four are not content: they are the turn's own bookkeeping (`session`,
// `done`) or a question only a human can answer (`permission`,
// `permission_result`), and swallowing one because it happened to carry a
// parent would strand the turn — a parked permission card nobody can see, or a
// `done` that never settles the composer. The route does not parent them today;
// this is what makes that a fact about the CLIENT rather than a bet on the
// server.
const TURN_LEVEL_EVENTS = new Set(["session", "done", "permission", "permission_result"]);

/**
 * One SSE frame, applied. TOTAL: an unrecognized event — and every CONTENT
 * frame carrying a `parent` — returns the state unchanged rather than throwing,
 * for the same reason the shell tombstones an unregistered item kind (AD-8).
 * The route's event vocabulary grows; a surface that has not caught up must
 * keep rendering the other nine frames.
 */
export function applyMasterEvent(
  state: MasterChatState,
  event: string,
  payload: unknown,
): MasterChatState {
  const data: Record<string, unknown> =
    payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  // Sub-agent CONTENT is not this surface's, yet — see the header and the set
  // above for what a parent may never suppress.
  if (data.parent && !TURN_LEVEL_EVENTS.has(event)) return state;

  switch (event) {
    case "session": {
      const id = str(data.sessionId);
      return id && id !== state.sessionId ? { ...state, sessionId: id } : state;
    }
    case "thinking":
      return {
        ...patchAssistant(state, (m) => mergeText(closeThinking(m), "thinking", "", false)),
        thinking: true,
        status: "streaming",
      };
    case "thinking_delta":
      return patchAssistant(state, (m) => mergeText(m, "thinking", str(data.text), false));
    case "delta":
      return {
        ...patchAssistant(state, (m) => mergeText(closeThinking(m), "text", str(data.text), false)),
        thinking: false,
        status: "streaming",
      };
    case "text":
      return {
        ...patchAssistant(state, (m) => mergeText(closeThinking(m), "text", str(data.text), true)),
        thinking: false,
        status: "streaming",
      };
    case "tool":
      return {
        ...patchAssistant(state, (m) => {
          const closed = closeThinking(m);
          return {
            ...closed,
            parts: [
              ...closed.parts,
              {
                type: "tool",
                name: str(data.name),
                id: str(data.id) || undefined,
                input: (data.input as Record<string, unknown> | undefined) ?? undefined,
              },
            ],
          };
        }),
        thinking: false,
        status: "streaming",
      };
    case "tool_result": {
      // BY PART ID, ACROSS EVERY MESSAGE — a result can outlive the bubble that
      // opened its call (tool_use ids are globally unique).
      const id = str(data.id);
      if (!id) return state;
      return {
        ...state,
        messages: state.messages.map((m) => ({
          ...m,
          parts: m.parts.map((p) =>
            p.type === "tool" && p.id === id
              ? { ...p, output: str(data.output), isError: data.isError === true }
              : p,
          ),
        })),
      };
    }
    case "permission": {
      // THE HUMAN-ACCEPT MOAT, ON SCREEN. The master's own tools are
      // auto-allowed by its profile; anything else that reaches here is a call
      // the guardrails want a human on, and the card is how it gets one.
      const id = str(data.id);
      if (!id) return state;
      return {
        ...appendPart(state, {
          type: "permission",
          id,
          toolName: str(data.toolName),
          input: (data.input as Record<string, unknown> | undefined) ?? {},
          rule: str(data.rule),
          ruleOptions: Array.isArray(data.ruleOptions)
            ? (data.ruleOptions as Array<{ rule: string; label: string }>)
            : [],
          status: "pending",
        }),
        thinking: false,
        status: "streaming",
      };
    }
    case "permission_result": {
      const id = str(data.id);
      if (!id) return state;
      return resolvePermission(state, id, data.behavior === "allow" ? "allowed" : "denied");
    }
    case "marker": {
      const text = str(data.text);
      if (!text) return state;
      return appendPart(state, {
        type: "marker",
        text,
        ...(data.attention === true ? { attention: true } : {}),
      });
    }
    case "interrupted":
      // The server's teardown flagged this turn's unresolved calls. Mirror it
      // so the live view matches what a reload would show instead of leaving a
      // tool row spinning after the stream has ended.
      //
      // NEVER OPENS A BUBBLE. patchAssistant's fallback exists so a stray
      // CONTENT frame outside a turn still has somewhere to go; this frame
      // adds no content, so with no assistant message trailing there is
      // nothing to flag and an empty bubble is all it could produce.
      if (state.messages[state.messages.length - 1]?.role !== "assistant") return state;
      return patchAssistant(state, (m) => ({
        ...m,
        parts: m.parts.map((p) =>
          p.type === "tool" && p.output === undefined ? { ...p, interrupted: true } : p,
        ),
      }));
    case "error": {
      const text = str(data.error) || str(data.message);
      return text
        ? { ...appendPart(state, { type: "marker", text, attention: true }), status: "error" }
        : { ...state, status: "error" };
    }
    case "done":
      return { ...state, status: "ready", thinking: false };
    default:
      return state;
  }
}

/** A card's answer, applied optimistically before the authoritative
 *  `permission_result` frame lands. Exported because the component answers a
 *  card from the renderer's `onRespond` hook, outside the stream.
 *
 *  `pending` IS A REAL ARGUMENT, not a leftover: it is how an optimistic answer
 *  is TAKEN BACK when the server refuses it (`{ok:false}` — already resolved,
 *  timed out, unknown — or a 400 on a rule that was never offered). A card
 *  reading "Allowed" over a harness still parked on the prompt is the one lie
 *  this surface must not tell. */
export function resolvePermission(
  state: MasterChatState,
  id: string,
  status: "pending" | "allowed" | "denied",
): MasterChatState {
  return {
    ...state,
    messages: state.messages.map((m) => ({
      ...m,
      parts: m.parts.map((p) => (p.type === "permission" && p.id === id ? { ...p, status } : p)),
    })),
  };
}
