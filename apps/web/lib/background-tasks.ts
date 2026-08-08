// THE SESSION'S LIVE BACKGROUND WORK, AS A LIST INSTEAD OF A NUMBER.
//
// WHAT THE HARNESS ACTUALLY SENDS. The Claude Agent SDK emits
// `system/background_tasks_changed` whenever the set of live background tasks
// changes — a backgrounded Bash command starting, a subagent finishing, a
// foreground agent being pushed to the background. Its payload is the FULL SET
// after the change (`{ task_id, task_type, description }[]`, REPLACE
// semantics), and the SDK's own doc is explicit that it is a LEVEL signal, not
// an edge: consumers are told to swap their set for each payload rather than
// pair `task_started`/`task_notification` bookends, "so a missed bookend cannot
// wedge a stale running indicator". It also warns not to correlate the level
// with the edge stream — the ids are the task roster's own, not tool_use ids.
//
// WHAT TELAR KEPT UNTIL NOW: `tasks.length`. One integer, spent on one line
// above the composer ("2 agents still working"), and the whole roster —
// including the DESCRIPTIONS, the only part that says what is actually running
// — thrown away at the point of receipt. That made the pinned environment,
// whose entire job is answering "what is this session touching RIGHT NOW",
// unable to name the background work at all, and it made the composer's line
// call a backgrounded `bun test` an "agent".
//
// SO THIS MODULE HOLDS THE LIST. It is pure (no React, no fetch, no I/O, no
// `@telar/core` edge) because both sides of the wire need it: the session
// runtime and the Claude projector on the server, `session-view.tsx` and
// `workspace-inspector.tsx` in the client bundle.
//
// CLAUDE ONLY, AND THE COMMENT IS THE MAP. `background_tasks_changed` is a
// Claude Agent SDK message. The Codex harness has no mapped equivalent on the
// app-server protocol telar consumes, so a Codex session's roster is simply
// always empty and every surface built on it renders nothing — which is honest
// (nothing is claimed) rather than wrong (no invented rows). If Codex ever
// grows a live-task signal, normalize it into `BackgroundTask` here and every
// consumer downstream works unchanged.

/** One live background task, normalized off the SDK's wire shape. `id` is the
 *  roster's own task id — deliberately NOT correlated with tool_use ids (the
 *  SDK forbids it); it exists to key a React list and to dedupe, nothing more. */
export type BackgroundTask = {
  id: string;
  /** The harness's raw `task_type`. Kept VERBATIM — see `backgroundTaskKind`
   *  for why nothing here narrows it to a union. */
  type: string;
  description: string;
};

/** The buckets telar counts in, in the order a summary line names them.
 *  "task" is the honest fallback, not a catch-all label anyone chose. */
export type BackgroundTaskKind = "command" | "agent" | "workflow" | "task";

const KIND_ORDER: readonly BackgroundTaskKind[] = ["command", "agent", "workflow", "task"];

const KIND_NOUN: Record<BackgroundTaskKind, string> = {
  command: "command",
  agent: "agent",
  workflow: "workflow",
  task: "task",
};

/** Which bucket a raw `task_type` falls in.
 *
 *  `task_type` IS AN OPAQUE STRING ON THE WIRE. The SDK types it as `string`,
 *  not a union, and documents exactly one value in passing (`local_workflow`),
 *  so anything stricter here would be a guess dressed as a contract — and the
 *  failure mode of a guess is a row that lies about what is running. Substring
 *  matching over a handful of stems, with an explicit "task" fallback, means an
 *  unrecognised type still SHOWS UP (its description is the useful half anyway)
 *  and is merely called what it provably is: a task. */
export function backgroundTaskKind(type: string): BackgroundTaskKind {
  const t = type.toLowerCase();
  if (t.includes("bash") || t.includes("shell") || t.includes("command")) return "command";
  if (t.includes("workflow")) return "workflow";
  if (t.includes("agent") || t.includes("task")) return "agent";
  return "task";
}

/** The SDK payload → telar's list. Tolerant by construction: this runs on
 *  whatever the harness sent, and a malformed entry must cost that entry, never
 *  the roster (a throw here would land in the runtime's message pump). Entries
 *  without an id are dropped — an un-keyable row cannot be rendered or
 *  reconciled — and a missing type/description degrades to an empty string,
 *  which the surfaces already render as "no detail" rather than as a claim. */
export function normalizeBackgroundTasks(raw: unknown): BackgroundTask[] {
  if (!Array.isArray(raw)) return [];
  const out: BackgroundTask[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const t = entry as { task_id?: unknown; id?: unknown; task_type?: unknown; type?: unknown; description?: unknown };
    // `task_id` is the SDK's field; `id` is what this module re-emits, so a
    // round-tripped list (done payload → client) normalizes idempotently.
    const id = typeof t.task_id === "string" ? t.task_id : typeof t.id === "string" ? t.id : "";
    if (!id) continue;
    const type =
      typeof t.task_type === "string" ? t.task_type : typeof t.type === "string" ? t.type : "";
    out.push({
      id,
      type,
      description: typeof t.description === "string" ? t.description : "",
    });
  }
  return out;
}

/** "1 command", "2 agents" — a count and the noun it earns. */
function countPhrase(kind: BackgroundTaskKind, n: number): string {
  const noun = KIND_NOUN[kind];
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The composer's aggregate line, told the truth by the roster.
 *
 *  It used to read "N agent(s) still working" for everything in the set,
 *  because a count is all there was — so a backgrounded `bun test` was an
 *  "agent" and a user watching one command and one subagent was told there were
 *  "2 agents". Grouping by kind costs one line of render and stops the sentence
 *  from lying: "1 command · 1 agent still working".
 *
 *  Empty in, empty out: the caller renders nothing at all rather than a line
 *  claiming zero of something (feel contract rule 20 — the line exists for
 *  exactly as long as it is true). */
export function backgroundWorkPhrase(tasks: readonly BackgroundTask[]): string {
  if (tasks.length === 0) return "";
  const counts = new Map<BackgroundTaskKind, number>();
  for (const task of tasks) {
    const kind = backgroundTaskKind(task.type);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  // Fixed kind order, not first-seen order: the line must not reshuffle itself
  // every time the roster changes membership — it sits in one place above the
  // composer and a jumping sentence reads as a new message.
  const parts = KIND_ORDER.filter((kind) => counts.has(kind)).map((kind) =>
    countPhrase(kind, counts.get(kind) as number),
  );
  return `${parts.join(" · ")} still working`;
}

/** The pinned environment's row label — what KIND of thing this is, in one
 *  word, beside the description that says which one. Capitalized because it is
 *  a row's label rather than prose inside a sentence. */
export function backgroundTaskLabel(task: BackgroundTask): string {
  const noun = KIND_NOUN[backgroundTaskKind(task.type)];
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}
