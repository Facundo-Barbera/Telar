// The master surface's session semantics, driven directly (story 5.7, CAP-3).
//
// WHY THIS FILE CAN EXIST AT ALL: lib/master-chat.ts is the adapter's state
// with React taken out — a payload builder, a seed and a total reducer — so the
// two things this story can actually get wrong are testable without a DOM. Both
// are load-bearing and neither is visible from the component:
//
//   1. THE TURN IS PROJECT-LESS. Story 5.6's own review found that a master
//      request carrying a project name ran the master with THAT project's
//      manifest, MCP servers and permissions bucket. The route shadows the
//      field defensively; this asserts the client never spells it.
//   2. THE REDUCER IS TOTAL. It handles a deliberately reduced slice of the
//      route's event vocabulary, so every frame it does NOT handle has to be a
//      no-op rather than a throw — including the sub-agent frames story 8 will
//      start emitting into a client that predates them.
//
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  applyMasterEvent,
  attachToMasterTurn,
  beginMasterTurn,
  endMasterTurn,
  INITIAL_MASTER_STATE,
  MASTER_SESSION_ROLE,
  masterTurnPayload,
  resolvePermission,
  seedMasterMessages,
  type MasterChatState,
} from "@/lib/master-chat";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, WEB_ROOT), "utf8");

// COMMENTS ARE NOT CODE — workspace-ui-idiom.test.ts's own reason, and it
// applies with force here: both files earn their keep by explaining at length
// why this surface has NO PROJECT, so the word "project" appears a dozen times
// in prose above code that never spells it. A scan that punished the
// explanation would delete the most useful lines in the story.
const stripComments = (src: string) =>
  src
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const code = (path: string) => stripComments(read(path));

const ADAPTER = "components/workspace/master-chat.tsx";
// The master chat is the workspace ROOT — ui-contract.md's "one top-level
// destination with two tabs — Chat (front door) and Queue (the drawer behind
// it)" — so the queue lives at app/workspace/queue/page.tsx and this is the
// page the sidebar's single Workspace entry lands on.
const PAGE = "app/workspace/page.tsx";

/** A state mid-turn: one user bubble, one assistant bubble open for the stream. */
const opened = (): MasterChatState =>
  beginMasterTurn(INITIAL_MASTER_STATE, { userId: "u1", assistantId: "a1", text: "dump" });

const drain = (state: MasterChatState, frames: Array<[string, unknown]>): MasterChatState =>
  frames.reduce((s, [event, payload]) => applyMasterEvent(s, event, payload), state);

const assistant = (state: MasterChatState) => state.messages[state.messages.length - 1]!;

describe("the master turn is project-less by construction", () => {
  test("the payload carries role master and NO project key at all", () => {
    const body = masterTurnPayload({ message: "hi", runId: "r1" });
    expect(body.role).toBe("master");
    expect(MASTER_SESSION_ROLE).toBe("master");
    // NOT `toBeUndefined()`: `{ project: undefined }` serializes to a body with
    // no project too, but it is a field someone can later fill in by accident.
    // The key must not be in the object.
    expect(Object.keys(body)).not.toContain("project");
    expect("project" in body).toBe(false);
    // And it must not appear on the wire under any other spelling.
    expect(JSON.stringify(body)).not.toContain("project");
  });

  test("optional identity rides only when it exists — never as an empty string", () => {
    const cold = masterTurnPayload({ message: "hi", runId: "r1" });
    expect(Object.keys(cold).sort()).toEqual(["message", "role", "runId"]);

    const warm = masterTurnPayload({
      message: "hi",
      runId: "r1",
      sessionId: "sess-1",
      account: "work",
      model: "sonnet",
    });
    expect(warm.sessionId).toBe("sess-1");
    expect(warm.account).toBe("work");
    expect(warm.model).toBe("sonnet");

    // A null session id is "no session yet", not a session named null: the
    // route resumes on `sessionId`, and an empty one would be a resume target
    // the harness cannot find.
    const fresh = masterTurnPayload({ message: "hi", runId: "r1", sessionId: null });
    expect("sessionId" in fresh).toBe(false);
  });

  test("role rides EVERY turn, not just the first", () => {
    // A resumed master anchors from the persisted Chat.role when the wire omits
    // it — but that fallback is for clients that cannot re-send. Relying on the
    // store to remember is how a resumed master 400s the day a row is written
    // without one.
    const resumed = masterTurnPayload({ message: "more", runId: "r2", sessionId: "sess-1" });
    expect(resumed.role).toBe("master");
  });
});

describe("the reducer is total", () => {
  test("an unknown event leaves the state identical", () => {
    const state = opened();
    for (const event of ["compacting", "compacted", "title", "saved", "task_status", "nonsense"]) {
      expect(applyMasterEvent(state, event, { anything: true })).toBe(state);
    }
  });

  test("a malformed payload never throws", () => {
    const state = opened();
    for (const payload of [null, undefined, "text", 42, []]) {
      expect(() => applyMasterEvent(state, "delta", payload)).not.toThrow();
      expect(() => applyMasterEvent(state, "tool_result", payload)).not.toThrow();
      expect(() => applyMasterEvent(state, "permission", payload)).not.toThrow();
    }
  });

  test("sub-agent CONTENT frames are ignored, not mis-filed onto the main thread", () => {
    // Story 8's per-project experts are the first frames to carry a `parent`.
    // Until a surface renders them, dropping one is honest; appending its text
    // to the master's own reply would not be.
    const state = opened();
    for (const [event, payload] of [
      ["delta", { text: "expert says", parent: "agent-1" }],
      ["text", { text: "expert says", parent: "agent-1" }],
      ["thinking", { parent: "agent-1" }],
      ["thinking_delta", { text: "hm", parent: "agent-1" }],
      ["tool", { name: "Read", id: "t9", parent: "agent-1" }],
      ["tool_result", { id: "t9", output: "…", parent: "agent-1" }],
      ["marker", { text: "spawned", parent: "agent-1" }],
      ["interrupted", { parent: "agent-1" }],
      // The route DOES parent this one (codex sub-thread errors) — a
      // sub-agent's failure is not the master's turn failing.
      ["error", { message: "expert died", parent: "agent-1" }],
    ] as Array<[string, unknown]>) {
      expect(applyMasterEvent(state, event, payload)).toBe(state);
    }
  });

  test("a parent can never suppress a TURN-LEVEL frame", () => {
    // The guard used to sit above the whole switch, so a parented `done` would
    // have left the composer streaming forever and a parented `permission`
    // would have parked a card nobody could see — a question only a human can
    // answer, dropped because of who asked it. The route does not parent these
    // today; this is what makes that a fact about the client.
    const state = opened();
    expect(applyMasterEvent(state, "session", { sessionId: "s1", parent: "a" }).sessionId).toBe("s1");
    expect(applyMasterEvent(state, "done", { parent: "a" }).status).toBe("ready");

    const card = applyMasterEvent(state, "permission", { id: "p1", toolName: "Bash", parent: "a" });
    expect(assistant(card).parts.at(-1)).toMatchObject({ type: "permission", status: "pending" });
    const answered = applyMasterEvent(card, "permission_result", {
      id: "p1",
      behavior: "allow",
      parent: "a",
    });
    expect(assistant(answered).parts.at(-1)).toMatchObject({ status: "allowed" });
  });

  test("an id-less permission, result or tool_result is a no-op, never a card with no id", () => {
    const state = opened();
    for (const event of ["permission", "permission_result", "tool_result"]) {
      expect(applyMasterEvent(state, event, { toolName: "Bash", output: "x" })).toBe(state);
      expect(applyMasterEvent(state, event, { id: "" })).toBe(state);
    }
  });

  test("a frame that adds nothing never opens an empty assistant bubble", () => {
    // `interrupted` flags open tool calls. With the last message the user's —
    // a frame arriving outside a turn this client opened — there is nothing to
    // flag, and patchAssistant's open-a-bubble fallback would produce a blank
    // assistant message the transcript renders as an empty reply.
    const user = beginMasterTurn(INITIAL_MASTER_STATE, {
      userId: "u1",
      assistantId: "a1",
      text: "dump",
    });
    const stray: MasterChatState = { ...user, messages: [user.messages[0]!] };
    expect(applyMasterEvent(stray, "interrupted", {})).toBe(stray);
  });
});

describe("a turn streams into the transcript", () => {
  test("text deltas accumulate into one part, closed by `text`", () => {
    const state = drain(opened(), [
      ["delta", { text: "Filed " }],
      ["delta", { text: "four." }],
    ]);
    expect(state.status).toBe("streaming");
    expect(assistant(state).parts).toEqual([{ type: "text", text: "Filed four.", done: false }]);

    const closed = applyMasterEvent(state, "text", { text: "Filed four." });
    expect(assistant(closed).parts).toEqual([
      { type: "text", text: "Filed four.", done: true },
    ]);
  });

  test("a thinking block closes when the answer starts", () => {
    const state = drain(opened(), [
      ["thinking", {}],
      ["thinking_delta", { text: "weighing lanes" }],
    ]);
    expect(state.thinking).toBe(true);
    expect(assistant(state).parts).toEqual([
      { type: "thinking", text: "weighing lanes", done: false },
    ]);

    const answered = applyMasterEvent(state, "delta", { text: "Done." });
    expect(answered.thinking).toBe(false);
    expect(assistant(answered).parts).toEqual([
      { type: "thinking", text: "weighing lanes", done: true },
      { type: "text", text: "Done.", done: false },
    ]);
  });

  test("a tool result lands on its call by id, even from an older message", () => {
    let state = drain(opened(), [
      ["tool", { name: "workspace.tasks", id: "t1", input: { op: "list" } }],
      ["done", {}],
    ]);
    // A second turn opens a new assistant bubble; the first turn's call is now
    // two messages back, and the late result still has to find it.
    state = beginMasterTurn(state, { userId: "u2", assistantId: "a2", text: "and?" });
    state = applyMasterEvent(state, "tool_result", { id: "t1", output: "4 items" });

    const call = state.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === "tool" && p.id === "t1");
    expect(call).toMatchObject({ output: "4 items", isError: false });
  });

  test("interrupted flags only the calls that never answered", () => {
    let state = drain(opened(), [
      ["tool", { name: "a", id: "t1" }],
      ["tool_result", { id: "t1", output: "ok" }],
      ["tool", { name: "b", id: "t2" }],
    ]);
    state = applyMasterEvent(state, "interrupted", {});
    const parts = assistant(state).parts.filter((p) => p.type === "tool");
    expect(parts[0]).not.toHaveProperty("interrupted", true);
    expect(parts[1]).toMatchObject({ interrupted: true });
  });

  test("a frame arriving outside a turn opens its own assistant bubble", () => {
    // Never append an assistant part to a user's message: the shell renders a
    // turn by `from`, so a stray delta would surface as the human's own words.
    const state = applyMasterEvent(INITIAL_MASTER_STATE, "delta", { text: "hello" });
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]!.role).toBe("assistant");
  });

  test("the session id is adopted once and not rewritten by an echo", () => {
    const first = applyMasterEvent(INITIAL_MASTER_STATE, "session", { sessionId: "s1" });
    expect(first.sessionId).toBe("s1");
    expect(applyMasterEvent(first, "session", { sessionId: "s1" })).toBe(first);
  });
});

describe("the permission card is how the moat reaches the screen", () => {
  test("a pending card renders, then settles on the answer", () => {
    const state = applyMasterEvent(opened(), "permission", {
      id: "p1",
      toolName: "Bash",
      input: { command: "ls" },
      rule: "Bash(ls:*)",
      ruleOptions: [{ rule: "Bash(ls:*)", label: "ls" }],
    });
    expect(assistant(state).parts.at(-1)).toMatchObject({
      type: "permission",
      id: "p1",
      status: "pending",
    });

    const allowed = resolvePermission(state, "p1", "allowed");
    expect(assistant(allowed).parts.at(-1)).toMatchObject({ status: "allowed" });

    const denied = applyMasterEvent(state, "permission_result", { id: "p1", behavior: "deny" });
    expect(assistant(denied).parts.at(-1)).toMatchObject({ status: "denied" });

    const allowedByFrame = applyMasterEvent(state, "permission_result", {
      id: "p1",
      behavior: "allow",
    });
    expect(assistant(allowedByFrame).parts.at(-1)).toMatchObject({ status: "allowed" });
  });

  test("an optimistic answer can be TAKEN BACK when the server refuses it", () => {
    // /api/chat/permission answers `{ok:false}` for an answer it could not take
    // (already resolved, timed out, unknown) and 400s a rule it never offered.
    // A card left reading "Allowed" over a harness still parked on the prompt
    // is the one lie the surface whose job is the accept-moat must not tell —
    // so the component reverts, and reverting has to be expressible.
    const card = applyMasterEvent(opened(), "permission", { id: "p1", toolName: "Bash" });
    const optimistic = resolvePermission(card, "p1", "allowed");
    expect(assistant(optimistic).parts.at(-1)).toMatchObject({ status: "allowed" });
    const reverted = resolvePermission(optimistic, "p1", "pending");
    expect(assistant(reverted).parts.at(-1)).toMatchObject({ status: "pending" });
  });

  test("the adapter checks the answer it posted, rather than firing and forgetting", () => {
    const src = code(ADAPTER);
    expect(src).toContain('await fetch("/api/chat/permission"');
    expect(src).toMatch(/body\?\.ok === false/);
    expect(src).toMatch(/resolvePermission\(s, id, "pending"\)/);
  });
});

describe("a turn always ends", () => {
  test("a clean close returns to ready", () => {
    const state = endMasterTurn(drain(opened(), [["done", {}]]));
    expect(state.status).toBe("ready");
    expect(state.thinking).toBe(false);
  });

  test("a failure is an attention marker IN the transcript, not chrome above it", () => {
    const state = endMasterTurn(opened(), { error: "Request failed (400)." });
    expect(state.status).toBe("error");
    expect(assistant(state).parts.at(-1)).toEqual({
      type: "marker",
      text: "Request failed (400).",
      attention: true,
    });
  });

  test("an `error` frame mid-stream says what went wrong", () => {
    const state = applyMasterEvent(opened(), "error", { error: "harness exited" });
    expect(state.status).toBe("error");
    expect(assistant(state).parts.at(-1)).toMatchObject({ attention: true, text: "harness exited" });
    // The route spells it `message` (guardrail refusals, route.ts) — both read.
    const routeShape = applyMasterEvent(opened(), "error", { message: "blocked by guardrails" });
    expect(routeShape.status).toBe("error");
  });

  test("a turn that already failed stays failed when the stream closes cleanly", () => {
    // The route emits `error` MID-STREAM for a guardrail refusal and then ends
    // the stream normally, so the component's teardown arrives with no error of
    // its own. A blanket reset to "ready" would erase the status under a marker
    // that is still on screen — the composer would claim a clean turn beneath a
    // red line, and the human would have no error affordance at all.
    const failed = applyMasterEvent(opened(), "error", { message: "blocked by guardrails" });
    const ended = endMasterTurn(failed, { error: null });
    expect(ended.status).toBe("error");
    expect(ended.thinking).toBe(false);
    // The marker is not duplicated by the close.
    expect(assistant(ended).parts.filter((p) => p.type === "marker")).toHaveLength(1);
    // …and a turn that did NOT fail still returns to ready.
    expect(endMasterTurn(drain(opened(), [["done", {}]])).status).toBe("ready");
  });

  test("a dropped stream cannot leave a live permission card behind", () => {
    // THE FAIL-CLOSE, AND IT IS THE MOAT'S OWN EDGE (5.7's review). The stream
    // carries the prompt AND its answer, so a turn that dies mid-prompt — an
    // aborted fetch, a killed harness, a network drop — leaves a card reading
    // "pending" with two live buttons under it. Clicking one POSTs an answer
    // for a run that no longer exists: at best a 400 the human is asked to
    // interpret, at worst a decision recorded against nothing. Closing DENIED
    // is the only safe direction — an unanswered guardrail prompt is a tool
    // that did not run, and the surface must not say otherwise.
    let state = applyMasterEvent(opened(), "permission", { id: "p1", toolName: "Bash" });
    state = endMasterTurn(state, { error: "network error" });
    expect(assistant(state).parts.find((p) => p.type === "permission")).toMatchObject({
      status: "denied",
    });
  });

  test("a clean close settles the loose ends too — `done` is not proof they were settled", () => {
    // The same reach on the non-error path: the harness can end a stream having
    // never answered a prompt it opened, and a `done` frame is not a promise
    // that it did.
    let state = applyMasterEvent(opened(), "permission", { id: "p1", toolName: "Bash" });
    state = endMasterTurn(drain(state, [["done", {}]]));
    expect(state.status).toBe("ready");
    expect(assistant(state).parts.find((p) => p.type === "permission")).toMatchObject({
      status: "denied",
    });
  });

  test("an answered card is left exactly as the human answered it", () => {
    const answered = resolvePermission(
      applyMasterEvent(opened(), "permission", { id: "p1", toolName: "Bash" }),
      "p1",
      "allowed",
    );
    const ended = endMasterTurn(answered, { error: "network error" });
    expect(assistant(ended).parts.find((p) => p.type === "permission")).toMatchObject({
      status: "allowed",
    });
  });

  test("a tool call the stream never answered is flagged interrupted, not completed", () => {
    // Without this the row renders as a FINISHED call with "(no output)" — a
    // tool that may well have written to the workspace store reported as having
    // run and returned nothing. `interrupted` is the shell's own built-in flag
    // and the same one the `interrupted` frame sets; the close is just the
    // other door into it, for the streams that never send that frame.
    let state = drain(opened(), [
      ["tool", { name: "workspace.tasks", id: "t1" }],
      ["tool_result", { id: "t1", output: "ok" }],
      ["tool", { name: "workspace.file", id: "t2" }],
    ]);
    state = endMasterTurn(state, { error: "aborted" });
    const calls = assistant(state).parts.filter((p) => p.type === "tool");
    expect(calls[0]).not.toHaveProperty("interrupted", true);
    expect(calls[1]).toMatchObject({ interrupted: true });
  });

  test("the close reaches every message, not just the trailing bubble", () => {
    // A tool_use id is globally unique and a call can outlive the bubble that
    // opened it (which is why `tool_result` searches all messages). A close
    // that only walked the last message would leave the previous turn's open
    // prompt live on screen.
    let state = applyMasterEvent(opened(), "permission", { id: "p1", toolName: "Bash" });
    state = beginMasterTurn(state, { userId: "u2", assistantId: "a2", text: "again" });
    state = endMasterTurn(state, { error: "aborted" });
    const card = state.messages
      .flatMap((m) => m.parts)
      .find((p) => p.type === "permission" && p.id === "p1");
    expect(card).toMatchObject({ status: "denied" });
  });
});

describe("the turn carries what the human pasted", () => {
  test("attachments ride the wire only when there are any", () => {
    const bare = masterTurnPayload({ message: "hi", runId: "r1", attachments: [] });
    expect("attachments" in bare).toBe(false);

    const withFile = masterTurnPayload({
      message: "look at this",
      runId: "r1",
      attachments: [{ id: "f1", name: "shot.png", mediaType: "image/png", size: 12 }],
    });
    expect(withFile.attachments).toEqual([
      { id: "f1", name: "shot.png", mediaType: "image/png", size: 12 },
    ]);
    // Still no project, whatever else rides along.
    expect(JSON.stringify(withFile)).not.toContain("project");
  });

  test("the chips land on the USER's bubble, after the text", () => {
    // The ids do not exist until the upload returns, so the bubble is opened
    // first and patched second — the text lands instantly, the chips follow.
    const state = attachToMasterTurn(opened(), "u1", [
      { id: "f1", name: "shot.png", mediaType: "image/png", size: 12 },
    ]);
    const user = state.messages[0]!;
    expect(user.role).toBe("user");
    expect(user.parts.map((p) => p.type)).toEqual(["text", "attachments"]);
    // A turn with nothing staged is untouched, identically.
    expect(attachToMasterTurn(state, "u1", [])).toBe(state);
    // An unknown id changes nothing — no bubble is invented for it.
    expect(attachToMasterTurn(state, "nope", [
      { id: "f2", name: "b", mediaType: "text/plain", size: 1 },
    ]).messages).toEqual(state.messages);
  });

  test("the adapter uploads bytes first and sends ids, never base64", () => {
    const src = code(ADAPTER);
    expect(src).toContain("uploadAttachments(files)");
    expect(src).toContain("attachToMasterTurn");
    // The shared uploader, not a second copy of the POST.
    expect(src).toContain('from "@/lib/attachment-upload"');
  });

  test("the composer is wrapped in a provider, which is what makes a rejected submit keep the words", () => {
    // Without a PromptInputProvider the composer is UNCONTROLLED and the
    // vendor's submit handler calls `form.reset()` BEFORE awaiting onSubmit —
    // so mid-turn Enter (where the submit control is a Stop button and the
    // vendor's disabled-guard finds nothing) cleared the textarea and the
    // rejection saved nothing. This is the one-line fix and it must not be
    // dropped by a later cleanup.
    const src = code(ADAPTER);
    expect(src).toContain("<PromptInputProvider>");
    expect(src).toContain("</PromptInputProvider>");
    // And the staged files are visible rather than silently swallowed.
    expect(src).toContain("<PromptInputAttachments />");
  });
});

describe("the persisted transcript seeds a reload", () => {
  test("text, markers and tools come back finished; nothing else comes back", () => {
    const seeded = seedMasterMessages([
      { role: "user", parts: [{ type: "text", text: "dump" }] },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Filed four." },
          { type: "marker", text: "one I can't place", attention: true },
          { type: "tool", name: "workspace.tasks", id: "t1", output: "ok" },
          // Attachments DO come back: the composer takes pasted and dropped
          // files, so a reload that dropped their chips would show a turn whose
          // text refers to a screenshot the transcript no longer mentions. The
          // shell's own built-in kind renders them (tombstone included once the
          // bytes are collected).
          { type: "attachments", files: [{ id: "f1", name: "a.pdf", mediaType: "x", size: 1 }] },
        ],
      },
    ]);
    expect(seeded).toHaveLength(2);
    expect(seeded[0]!.parts).toEqual([{ type: "text", text: "dump", done: true }]);
    expect(seeded[1]!.parts.map((p) => p.type)).toEqual([
      "text",
      "marker",
      "tool",
      "attachments",
    ]);
    expect(seeded[1]!.parts[0]).toMatchObject({ done: true });
  });

  test("a seeded tool row carries every field the row can DRAW", () => {
    // THE RELOAD MUST NOT REWRITE HISTORY (5.7's review). The seed used to
    // re-spell each part by hand and copy a subset of its keys, so a reload
    // silently promoted a denied call to a plain one: `autoDenied` is what the
    // shell's tool row uses to say "the guardrail refused this", and dropping
    // it renders a refusal as an ordinary empty result — the accept-moat's own
    // evidence, erased by a page refresh. `interrupted` is the same story for
    // the fail-close above, and `agent`/`taskStatus` for story 8's sub-agents.
    const seeded = seedMasterMessages([
      {
        role: "assistant",
        parts: [
          {
            type: "tool",
            name: "Bash",
            id: "t1",
            input: { command: "rm -rf /" },
            isError: true,
            autoDenied: true,
            interrupted: true,
            parentId: "t0",
            agent: { type: "scout", description: "reads the store" },
            taskStatus: "completed",
          },
          { type: "marker", text: "handed to the scout", attention: true, agentId: "scout-1" },
        ],
      },
    ]);
    expect(seeded[0]!.parts[0]).toMatchObject({
      type: "tool",
      name: "Bash",
      id: "t1",
      isError: true,
      autoDenied: true,
      interrupted: true,
      parentId: "t0",
      agent: { type: "scout", description: "reads the store" },
      taskStatus: "completed",
    });
    expect(seeded[0]!.parts[1]).toMatchObject({
      type: "marker",
      text: "handed to the scout",
      attention: true,
      agentId: "scout-1",
    });
  });

  test("absent flags stay absent — a seed invents nothing", () => {
    // The mirror image, and the reason each optional key is spread rather than
    // assigned: a row seeded with `autoDenied: undefined` reads differently to
    // a row without the key at all once it is JSON round-tripped.
    const seeded = seedMasterMessages([
      { role: "assistant", parts: [{ type: "tool", name: "Read", id: "t1", output: "ok" }] },
    ]);
    const part = seeded[0]!.parts[0]!;
    expect(part).not.toHaveProperty("autoDenied");
    expect(part).not.toHaveProperty("agent");
    expect(part).not.toHaveProperty("parentId");
  });

  test("every seeded message has a distinct id", () => {
    const seeded = seedMasterMessages([
      { role: "user", parts: [] },
      { role: "assistant", parts: [] },
      { role: "user", parts: [] },
    ]);
    expect(new Set(seeded.map((m) => m.id)).size).toBe(3);
  });
});

// ── the adapter's own contract, read from its source ─────────────────────────
//
// There is no DOM harness in this repo, and the properties below are structural
// rather than behavioural — the same reason workspace-ui-idiom.test.ts and
// dock-migration.test.ts scan sources.
describe("the master surface is an owner adapter on the shared shell", () => {
  test("it mounts `Conversation` from the one roof, and rebuilds no chat window", () => {
    const src = read(ADAPTER);
    expect(src).toContain('from "@/components/conversation"');
    expect(src).toContain("<Conversation");
    // The four slots, configured — not a fork of session-view.
    expect(src).toMatch(/items=\{transcriptItems\}/);
    expect(src).toMatch(/kinds=\{MASTER_KINDS\}/);
    expect(src).toMatch(/composer=\{/);
    expect(src).toMatch(/rail=\{<DeskRail \/>\}/);
    expect(src).not.toContain("components/session/session-view");
  });

  test("the registry is a prop built once, never a module singleton the shell reads", () => {
    const src = read(ADAPTER);
    expect(src).toContain("createItemKindRegistry([...BUILTIN_KINDS])");
  });

  test("the composer carries no Ultra chip and no session configuration", () => {
    // ui-contract.md §1: "No Ultra chip here — ultra's mutating tools
    // dereference a project, which the master lacks."
    const src = read(ADAPTER);
    expect(src).not.toMatch(/<Ultra/);
    expect(src).not.toMatch(/ultraChip|UltraToggle|PermissionModeMenu|ModelPicker/);
  });

  test("the surface states its pull-based contract in words", () => {
    // ui-contract.md §1's last line, and CAP-3's "the surface never notifies".
    expect(read(ADAPTER)).toContain("this surface never notifies you");
  });

  test("everything ui-contract §1 asks for and this story does NOT ship is named as deferred", () => {
    // A skipped element is a decision or an oversight, and the difference is
    // whether the file says so (5.7's review caught the bed-mode chip skipped
    // silently). The chip reports a run — window, action count, `0 started` —
    // and there is no runner and no digest to report one from; story 11's own
    // brief calls that report "a real invariant to assert against, not display
    // copy", so shipping a hardcoded one would be exactly the display copy it
    // forbids. What must be true is that the deferral is WRITTEN DOWN, with its
    // owner, beside the other four.
    const src = read(ADAPTER);
    expect(src).toMatch(/bed[- ]mode/i);
    expect(src).toContain("story 11");
    // …and it stayed deferred: no tally, no window, no clock.
    const body = code(ADAPTER);
    expect(body).not.toMatch(/0 started/);
    expect(body).not.toMatch(/toLocaleTimeString|toLocaleDateString|new Date\(/);
  });

  test("nothing here polls, and nothing here notifies", () => {
    const src = read(ADAPTER);
    expect(src).not.toMatch(/setInterval|setTimeout\(/);
    expect(src).not.toMatch(/Notification|navigator\.vibrate|new Audio/);
  });

  test("the turn body comes from the tested builder, not a hand-spelled object", () => {
    // The one property this whole file exists for cannot be asserted about the
    // component's behaviour — only about where its body comes from.
    const src = code(ADAPTER);
    expect(src).toContain("masterTurnPayload({");
    expect(src).not.toMatch(/role:\s*"master"/);
    // NOT ONE MENTION IN CODE. The adapter cannot send a project it never
    // names, whatever a future edit does to the builder's optional keys.
    expect(src).not.toMatch(/\bproject\b/);
  });
});

describe("the route resumes the master rather than addressing one", () => {
  test("the page is force-dynamic and finds the master by its persisted role", () => {
    const src = read(PAGE);
    expect(src).toContain('export const dynamic = "force-dynamic"');
    expect(src).toContain('c.role === "master"');
    expect(src).toContain('archived: "exclude"');
  });

  test("the route takes no project and no session id", () => {
    const src = code(PAGE);
    expect(src).not.toMatch(/params\s*:/);
    expect(src).not.toMatch(/\bproject\b/);
  });

  test("no enabled account is a stated condition, not a composer that 400s", () => {
    const src = read(PAGE);
    expect(src).toContain("resolveEnabledAccount()");
    expect(src).toContain("<EmptyState");
  });

  test("the no-account branch keeps the destination's two tabs", () => {
    // A destination that stops being two-tabbed when something is wrong is a
    // dead end: without the header this branch's only route to the queue is the
    // global sidebar, which points HERE.
    const src = read(PAGE);
    const branch = src.slice(src.indexOf("if (!account)"), src.indexOf("</div>\n    );"));
    expect(branch).toContain("<WorkspaceTabs active=\"chat\" />");
    expect(branch).toContain("<PageHeader");
  });

  test("the RESUMED account is re-validated, and a moved one resumes as history only", () => {
    // An account can be disabled or removed between two sit-downs. Taken on
    // faith, `chat.account` gives back a composer whose every Enter 400s at the
    // route's account gate — reported as a red line in the transcript with
    // nothing offered. And once the account has moved, the harness session id
    // is meaningless under a different config dir, so the transcript still
    // seeds (it is still true) but the resume pointer does not ride along.
    const src = code(PAGE);
    expect(src).toContain("resolveEnabledAccount(chat?.account)");
    expect(src).toMatch(/resolveEnabledAccount\(chat\?\.account\) \?\? resolveEnabledAccount\(\)/);
    expect(src).toContain("account === chat?.account");
    expect(src).toMatch(/resumable && chat\?\.id \? \{ initialSessionId: chat\.id \}/);
    // The transcript is NOT gated on resumability — history survives the move.
    expect(src).toMatch(/initialMessages=\{chat\?\.messages\}/);
  });

  test("chat holds the ROOT, the queue moved below it, and item deep links survive", () => {
    // ui-contract.md, first line of "Shell": "Workspace is one top-level
    // destination with two tabs — Chat (front door) and Queue (the drawer
    // behind it). The queue does not pretend to be its own destination." A chat
    // nested at /workspace/chat states that backwards — the sidebar's single
    // Workspace entry would land on the drawer with the front door inside it.
    expect(read(PAGE)).toContain("<MasterChat");
    expect(read("app/workspace/queue/page.tsx")).toContain("<QueueView />");
    // THE MOVE'S ONE HAZARD, PINNED: `/workspace/<id>` is a packet deep link,
    // and a static `queue` segment sits in the same position. Next resolves a
    // static segment ahead of a dynamic one, and item ids are minted `i-<hex>`
    // (packages/core/src/workspace/store.ts, createItem), so no item can be
    // addressed "queue" — but the dynamic route has to still BE there.
    expect(read("app/workspace/[id]/page.tsx")).toContain("params");
  });
});
