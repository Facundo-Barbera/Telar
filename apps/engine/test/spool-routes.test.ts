/**
 * The Spool over HTTP — the daemon's routes and the typed client, end to end.
 *
 * SEPARATE FROM `spool-store.test.ts`, which drives the store directly against a
 * temp directory. That suite owns the rules; this one owns the seam, and the
 * distinction matters because the seam is where the store's two-vocabulary
 * contract ("a read is tolerant, a write is loud") has to become status codes
 * without losing the sentences. A refusal that arrives as a bare 400 is a
 * regression this file catches and that one cannot.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import type { GhRunner } from "../src/github";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

async function spool(options: { gh?: GhRunner } = {}): Promise<EngineClient> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-routes-"));
  roots.push(directory);
  const daemon = await startEngine({ engineRoot: directory, ...(options.gh ? { gh: options.gh } : {}) });
  daemons.push(daemon);
  return new EngineClient(daemon.discovery);
}

/** An injected `gh` whose world a test can move between looks — the daemon
 *  never shells out, and the look route's whole path is still the real one. */
function movableWorld() {
  const state = { issues: [] as unknown[], pulls: [] as unknown[] };
  const gh: GhRunner = async (_cwd, args) => ({
    status: 0,
    stdout: JSON.stringify(args[0] === "issue" ? state.issues : state.pulls),
    stderr: "",
  });
  return { state, gh };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

test("an untouched engine serves an empty spool rather than a 404 or a throw", async () => {
  // A store that has never been written is the ordinary first-run state. The
  // queue surface has to be able to render it.
  const client = await spool();
  await expect(client.spool()).resolves.toEqual({
    lanes: [],
    rows: [],
    // Both axes ship from every read, so an empty store is empty on both — a
    // surface grouping by subject must not have to special-case first run.
    subjects: [],
    desk: [],
    unreadable: [],
    totalItems: 0,
    agentsAdded: 0,
  });
});

test("creating an item seeds the store, files it, and puts it on the desk in one snapshot", async () => {
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "call María", creationNote: "captured in session s-1" });

  // Stamped server-side, never from input — and the HUMAN API's stamp is the
  // human's: this route is the workbench form's path, with no agent near it.
  expect(item.provenance).toBe("you");
  expect(item.desk).toBe(true);

  const snapshot = await client.spool();
  expect(snapshot.lanes.map((l) => l.key)).toEqual(["unfiled"]); // the ensure step seeded it
  expect(snapshot.rows.map((r) => [r.lane, r.rank, r.item.id])).toEqual([["unfiled", 1, item.id]]);
  expect(snapshot.desk.map((d) => d.id)).toEqual([item.id]);
  expect(snapshot.totalItems).toBe(1);
  // A hand-made item is NOT "agents added" — the conservation line must not
  // claim an agent did what the user did by hand.
  expect(snapshot.agentsAdded).toBe(0);
  // The SUBJECT axis crosses the wire from the same read: this item named no
  // project, so it rests in the floating group — which the response carries
  // rather than dropping, or a first capture would be invisible on the surface
  // that groups by subject.
  expect(snapshot.subjects.map((g) => [g.project, g.rows.map((r) => r.item.id)])).toEqual([[undefined, [item.id]]]);
});

test("the item detail answers lane and rank from the STACKS, not from the packet's hint", async () => {
  const client = await spool();
  await client.createSpoolLane({ label: "Office", window: "work hours" });
  const { item } = await client.createSpoolItem({ title: "filed", lane: "office" });

  const detail = await client.spoolItem(item.id);
  expect(detail.lane).toBe("office");
  expect(detail.rank).toBe(1);
  expect(detail.attachments).toEqual([]);
  expect(detail.tally).toEqual({ files: 0, mockups: 0 });

  await expect(client.spoolItem("i-nothing")).rejects.toBeInstanceOf(EngineClientError);
});

test("a forbidden patch key is refused with the store's own sentence, not a bare 400", async () => {
  // The engine translates the store's throw into `invalid_request` and CARRIES
  // ITS TEXT. That text names the field and why it cannot be written; replacing
  // it with a generic message would throw away the only actionable part.
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "the user's own words", raw: "clunky?? ask diego" });

  const hostile = client.updateSpoolItem(item.id, { raw: "REWRITTEN" } as never);
  await expect(hostile).rejects.toThrow(/raw/);

  // …and nothing was written.
  expect((await client.spoolItem(item.id)).item.raw).toBe("clunky?? ask diego");
});

test("THE CHECKBOX over HTTP: close stamps and cascades, reopen unticks and resurrects nothing", async () => {
  // docs/spool-loops.md §9, end to end: the dedicated human routes, the exact
  // cascade wording, and the drain-not-delete record on the timeline.
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "paridad", project: "ozom-gv", raw: "revisar paridad" });
  const opened = await client.openSpoolThread("ozom-gv", { question: "Does the ad data match?", items: [item.id] });

  const closed = await client.closeSpoolItem(item.id);
  expect(closed.item.closed?.label).toBeDefined();
  expect(typeof closed.item.closed?.at).toBe("number");
  expect(closed.item.timeline?.at(-1)).toMatchObject({ actor: "you", text: "closed by hand" });
  // ONE GESTURE, EVERYTHING OVER — the open thread settled with the honest
  // answer, attributed to nobody but the human whose click this was.
  expect(closed.settledThreads.map((t) => t.id)).toEqual([opened.thread.id]);
  expect(closed.settledThreads[0]!.settled?.answer).toBe("the user closed the task");
  expect(closed.refused).toEqual([]);

  // Closing again: idempotent, with the honest note instead of a re-stamp.
  const again = await client.closeSpoolItem(item.id);
  expect(again.note).toContain("Already closed");
  expect(again.item.closed).toEqual(closed.item.closed);
  expect(again.settledThreads).toEqual([]);

  // THE SHELF, NOT A HOLE: the closed item still counts, still ships, marked.
  const snapshot = await client.spool();
  expect(snapshot.totalItems).toBe(1);
  expect(snapshot.desk.find((c) => c.id === item.id)?.closed).toEqual(closed.item.closed);

  // Reopen unticks — and the cascade-settled thread STAYS settled: a settled
  // thread is never removed, and un-settling would rewrite the record.
  const reopened = await client.reopenSpoolItem(item.id);
  expect(reopened.item.closed).toBeUndefined();
  expect(reopened.item.timeline?.at(-1)).toMatchObject({ actor: "you", text: "reopened by hand" });
  const map = await client.spoolThreads("ozom-gv");
  expect(map.threads[0]!.thread.settled?.answer).toBe("the user closed the task");

  // Reopening the open item: the same honest idempotency.
  expect((await client.reopenSpoolItem(item.id)).note).toContain("Already open");
});

test("`closed` CANNOT travel through the generic patch — the one route a tool capability reaches", async () => {
  // The dedicated routes above are the ONLY writers. The tool wall's update
  // capability lands on PATCH /items/:id, so the store must refuse `closed`
  // there by name — silently dropping it would be indistinguishable from a
  // close that never cascaded.
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "x" });
  const hostile = client.updateSpoolItem(item.id, { closed: { label: "Tue 16:42", at: 1 } } as never);
  await expect(hostile).rejects.toThrow(/closed/);
  // …and nothing landed.
  expect((await client.spoolItem(item.id)).item.closed).toBeUndefined();
});

test("a lane retire REFUSAL is a 200 result carrying its reason, not an error", async () => {
  // Every refusal names what the human must move first. A 4xx would let a client
  // render it as a toast and drop the sentence that made it actionable.
  const client = await spool();
  const { lane } = await client.createSpoolLane({ label: "Office", window: "work hours" });
  await client.createSpoolItem({ title: "still in it", lane: lane.key });

  const refused = await client.retireSpoolLane(lane.key);
  expect(refused.ok).toBe(false);
  if (!refused.ok) expect(refused.reason).toContain("never evicts an item on the human's behalf");
  expect((await client.spoolLanes()).lanes.map((l) => l.key)).toContain(lane.key);

  // The seed lane is refused too, and for its own stated reason.
  const seed = await client.retireSpoolLane("unfiled");
  expect(seed.ok).toBe(false);
  if (!seed.ok) expect(seed.reason).toContain("cannot be placed");
});

test("sub-tasks never grow the queue, and only the promote route takes one out", async () => {
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "decompose me" });
  const before = (await client.spool()).rows.length;

  await client.addSpoolSubtask(item.id, "first step");
  const { item: withTwo } = await client.addSpoolSubtask(item.id, "second step");
  expect(withTwo.subtasks!.length).toBe(2);
  // THE CONSERVATION LAW, over the wire: breaking work down never grows the count.
  expect((await client.spool()).rows.length).toBe(before);
  expect((await client.spool()).totalItems).toBe(1);

  const done = await client.setSpoolSubtaskDone(item.id, withTwo.subtasks![0]!.id, true);
  expect(done.item.subtasks![0]!.done).toBe(true);
  expect(done.item.subtasks![1]!.done).toBe(false);

  const { promoted } = await client.promoteSpoolSubtask(item.id, withTwo.subtasks![1]!.id);
  expect(promoted.promotedFrom).toBe(item.id);
  // NOW the count grows — because a human said so, which is the only path that
  // may grow it.
  expect((await client.spool()).totalItems).toBe(2);
  expect((await client.spoolItem(item.id)).item.subtasks!.length).toBe(1);
});

test("lanes rename, reorder, and retire when empty — the four human-only verbs", async () => {
  const client = await spool();
  const { lane } = await client.createSpoolLane({ label: "Evenings & Weekends", window: "after 6pm" });
  expect(lane.key).toBe("evenings-weekends"); // minted from the label, never supplied

  const a = (await client.createSpoolItem({ title: "a", lane: lane.key })).item;
  const b = (await client.createSpoolItem({ title: "b", lane: lane.key })).item;
  expect((await client.reorderSpoolLane(lane.key, [b.id, a.id])).lane.items).toEqual([b.id, a.id]);
  expect((await client.spool()).rows.map((r) => r.item.id)).toEqual([b.id, a.id]);

  const renamed = await client.renameSpoolLane(lane.key, "Evenings");
  expect(renamed.lane).toEqual({ key: lane.key, label: "Evenings", window: "after 6pm", items: [b.id, a.id] });

  await expect(client.renameSpoolLane("nope", "x")).rejects.toBeInstanceOf(EngineClientError);
  await expect(client.reorderSpoolLane(lane.key, ["i-ghost"])).rejects.toThrow(/does not resolve/);

  // Empty, and not the seed lane: it retires.
  const { lane: empty } = await client.createSpoolLane({ label: "Free", window: "whenever" });
  await expect(client.retireSpoolLane(empty.key)).resolves.toEqual({ ok: true });
});

test("a lane split moves exactly the named rows and leaves the rest behind, in order", async () => {
  const client = await spool();
  await client.createSpoolLane({ label: "Office", window: "work hours" });
  const a = (await client.createSpoolItem({ title: "a", lane: "office" })).item;
  const b = (await client.createSpoolItem({ title: "b", lane: "office" })).item;
  const c = (await client.createSpoolItem({ title: "c", lane: "office" })).item;

  const { source, created } = await client.splitSpoolLane(
    "office",
    { label: "Evenings", window: "after 6pm", note: "split from Office — you accepted it" },
    [a.id, c.id],
  );

  expect(created.key).toBe("evenings");
  expect(created.items).toEqual([a.id, c.id]);
  // WHAT STAYS IS COMPUTED AGAINST THE STACK AS IT WAS. Reading it after the
  // first reorder would leave the source empty.
  expect(source.items).toEqual([b.id]);
  // Structural provenance is permanent: a lane made by an accepted proposal
  // says so, forever.
  expect(created.note).toContain("you accepted it");

  const snapshot = await client.spool();
  expect(snapshot.rows.map((r) => [r.lane, r.rank, r.item.id])).toEqual([
    ["office", 1, b.id],
    ["evenings", 1, a.id],
    ["evenings", 2, c.id],
  ]);
  // The split MOVED items; it did not create or destroy any.
  expect(snapshot.totalItems).toBe(3);

  await expect(client.splitSpoolLane("nope", { label: "x", window: "y" }, [])).rejects.toThrow(/No lane named/);
});

test("the unreadable channel reaches the client, so tolerance is never silent loss", async () => {
  // A lane row the store cannot parse is SKIPPED and reported. If the snapshot
  // dropped that channel, the user would watch a lane vanish with no sign why.
  const client = await spool();
  await client.createSpoolItem({ title: "seeds the store" });
  const lanesFile = path.join(roots[roots.length - 1]!, "spool", "lanes.json");
  fs.writeFileSync(
    lanesFile,
    JSON.stringify([
      { key: "unfiled", label: "Unfiled", window: "whenever", items: [] },
      { key: "school", label: "School", items: [] }, // the human dropped `window`
    ]),
  );

  const snapshot = await client.spool();
  expect(snapshot.lanes.map((l) => l.key)).toEqual(["unfiled"]);
  expect(snapshot.unreadable.map((u) => u.id)).toEqual(["school"]);
  expect(snapshot.unreadable[0]!.reason).toContain("SKIPPED");
});

test("the master chat is a project-less singleton rooted at the spool's own home", async () => {
  const client = await spool();
  const { session } = await client.spoolMaster();

  // NO PROJECT — absent, not a synthetic one. This is what makes the spool
  // toolkit report "all projects" and MCP resolution hand it the environment's
  // globals only.
  expect(session.projectId).toBeUndefined();
  // Its cwd is the dedicated empty directory beside the store, never inside it.
  expect(session.workspace.path).toBe(path.join(roots[roots.length - 1]!, "spool", "home"));
  expect(session.workspace.mode).toBe("local");
  // Attended: a front door has no business running unattended.
  expect(session.detached).toBe(false);
  // …and "auto", not the attended default: its tools are read-and-propose
  // verbs and every consequential act is gated by the store's human-only
  // verbs, so approval-required here would only park the conversation.
  expect(session.runtimeMode).toBe("auto");

  // A SINGLETON. Calling twice returns the same session rather than a second
  // front door — "one project-less conversation" is the contract, and a list of
  // front doors is not one.
  const again = await client.spoolMaster();
  expect(again.session.id).toBe(session.id);

  // …and it holds no store files: lanes.json and packets/ are its SIBLINGS.
  expect(fs.readdirSync(session.workspace.path)).toEqual([]);
});

test("ensure repairs a master persisted under the old attended default", async () => {
  /**
   * THE DEFAULT MOVED, AND THE SINGLETON ON DISK HAS TO MOVE WITH IT. The
   * master used to be minted approval-required, so every existing install
   * holds one that parks on requests no matter what the new default says —
   * a singleton nobody created deliberately is the module's to repair, and
   * ensure is the one seam every arrival already passes through.
   */
  const client = await spool();
  const { session } = await client.spoolMaster();
  expect(session.runtimeMode).toBe("auto");

  // An install from before the change: the same session, persisted attended.
  const metadata = path.join(roots[roots.length - 1]!, "sessions", session.id, "session.json");
  const stored = JSON.parse(fs.readFileSync(metadata, "utf8"));
  stored.runtimeMode = "approval-required";
  fs.writeFileSync(metadata, JSON.stringify(stored));

  const repaired = await client.spoolMaster();
  expect(repaired.session.id).toBe(session.id);
  expect(repaired.session.runtimeMode).toBe("auto");
  // And the repair persisted — the next read agrees with what was returned.
  expect(JSON.parse(fs.readFileSync(metadata, "utf8")).runtimeMode).toBe("auto");
});

test("a project-scoped session list never contains the master", async () => {
  // Absence of a project is a positive statement, and the reader that filters by
  // project has to treat it as one rather than as a session it failed to place.
  const client = await spool();
  const { session } = await client.spoolMaster();
  const { project } = await client.registerProject({ name: "aurora", root: roots[roots.length - 1]! });
  const listed = await client.listSessions(project.id);
  expect(listed.sessions.map((s) => s.id)).not.toContain(session.id);
});

/**
 * THE EXPERT ROUTE, ASSERTED ONLY ON WHAT REFUSES BEFORE THE MODEL CALL.
 *
 * Every case below returns before a cent is spent, which is exactly why they are
 * the cases worth pinning here: the model half is driven with an injected
 * `invoke` in `spool-expert.test.ts`, and a route test that reached a provider
 * would be slow, flaky and billed. What this file owns is the SEAM — that a
 * refusal survives HTTP with its sentence and its status intact.
 */
test("a floating item's refusal crosses HTTP as a 200 with its sentence, not a 4xx", async () => {
  // Same reasoning as the lane-retire refusal: "this item has no project, so it
  // has no expert" is the ANSWER to what the caller asked, not a malformed
  // request. A 4xx invites a client to render an error toast and drop the
  // sentence that named the next move.
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "a loose thought" });

  const outcome = await client.consultSpoolExpert(item.id);

  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toContain("floating");
    expect(outcome.reason).toContain("a loose thought");
    expect(outcome.reason).toContain("File it into a project first");
  }
});

test("a project name the store cannot address is refused before any model runs", async () => {
  // The check exists because `SpoolItem.project` is a free string with no slug
  // guard while a digest is a directory name. Without it the mismatch surfaced
  // after the model call and after the packet write.
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "x", project: "My Project/../etc" });

  const outcome = await client.consultSpoolExpert(item.id);

  expect(outcome.ok).toBe(false);
  if (!outcome.ok) {
    expect(outcome.reason).toContain("no expert was called");
    expect(outcome.reason).toContain("nothing was written");
  }
});

test("consulting an item that does not exist is a 404, not a refusal", async () => {
  // The one case that IS a bad request rather than an answer: there is no item
  // to have an opinion about. Distinguished so a client can tell "I asked about
  // the wrong thing" from "the expert declined".
  const client = await spool();

  await expect(client.consultSpoolExpert("i-nope")).rejects.toBeInstanceOf(EngineClientError);
});

/**
 * THE TOOL SURFACE OVER THE REAL DAEMON — the master's capability, exactly as
 * the worker builds it, driven end to end.
 *
 * THE SECOND-TOUCH REGRESSION LIVES HERE. A live agent reported update changes
 * "applying on the second touch"; the transcript showed the real cause was a
 * concurrent out-of-band writer racing its retries — the master could not set
 * a subject at all, so filing happened around the toolkit and looked like
 * latency from inside it. This suite pins the property that clears the tool
 * path itself: ONE update, and the immediately following read through the same
 * surface already shows it.
 */
async function masterTools(client: EngineClient) {
  const { spoolTools } = await import("../src/spool/tools");
  const registered: Array<{ name: string; run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }> }> = [];
  const factory = (name: string, _d: string, _s: Record<string, unknown>, run: never) => {
    registered.push({ name, run });
    return { name };
  };
  spoolTools(factory as never, {
    snapshot: () => client.spool(),
    item: (id) => client.spoolItem(id).catch(() => null),
    create: async (input) => (await client.createSpoolItem(input)).item,
    update: async (id, patch) => (await client.updateSpoolItem(id, patch)).item,
    consult: (id) => client.consultSpoolExpert(id),
    map: () => client.spoolMap(),
    openThread: async (subject, input) => (await client.openSpoolThread(subject, input)).thread,
    setWaiting: async (subject, threadId, waiting) => (await client.setSpoolThreadWaiting(subject, threadId, waiting)).thread,
    settle: async (subject, threadId, answer) => (await client.settleSpoolThread(subject, threadId, answer)).thread,
    answer: async (itemId, question, answer) => (await client.answerSpoolQuestion(itemId, question, answer)).item,
    focus: () => client.spoolFocus(),
    setFocus: async (input) => (await client.openSpoolFocus(input)).focus,
    endFocus: async (id, end) => (await client.closeSpoolFocus(id, end)).focus,
    look: async (subjectKey) => (await client.reconcileSpoolLook(subjectKey)).look,
    setTerrain: async (subjectKey, terrain) => (await client.setSpoolSubjectTerrain(subjectKey, terrain)).subject,
    setIdentity: async (subjectKey, patch) => (await client.setSpoolSubjectIdentity(subjectKey, patch)).subject,
    setAperture: async (view) => (await client.setSpoolAperture(view)).aperture,
    setAreaPermits: async (name, ceiling) => (await client.setSpoolAreaCeiling(name, ceiling)).area,
  });
  return async (name: string, args: Record<string, unknown> = {}) => {
    const found = registered.find((t) => t.name === name);
    if (!found) throw new Error(`no tool named ${name}`);
    const result = await found.run(args);
    const text = String((result.content[0] as { text: string }).text);
    return { text, isError: result.isError === true };
  };
}

test("one update is visible on the immediately following read, through the same tool surface", async () => {
  const client = await spool();
  const call = await masterTools(client);

  const created = JSON.parse((await call("spool_create_item", { title: "before" })).text);
  const updated = JSON.parse(
    (await call("spool_update_item", { itemId: created.id, title: "after", subjectKey: "ozom-gv" })).text,
  );
  // The tool's own response reflects the write…
  expect(updated.title).toBe("after");
  expect(updated.project).toBe("ozom-gv");
  // …and so does the very next read, with no second touch anywhere.
  const listed = JSON.parse((await call("spool_list_items", {})).text);
  const row = listed.items.find((i: { id: string }) => i.id === created.id);
  expect(row.title).toBe("after");
  expect(row.project).toBe("ozom-gv");
});

test("the master files to a subject in one touch — the premise repair, end to end", async () => {
  const client = await spool();
  const call = await masterTools(client);
  const created = JSON.parse(
    (await call("spool_create_item", { title: "los presupuestos no cuadran", subjectKey: "ozom-gv" })).text,
  );
  const listed = JSON.parse((await call("spool_list_items", {})).text);
  expect(listed.items.find((i: { id: string }) => i.id === created.id).project).toBe("ozom-gv");
});

test("a deadline is a quoted pair — half of one is refused before anything writes", async () => {
  const client = await spool();
  const call = await masterTools(client);
  const half = await call("spool_create_item", { title: "with a date", deadlineLabel: "Sep 2" });
  expect(half.isError).toBe(true);
  expect(half.text).toContain("pair");
  const whole = JSON.parse(
    (await call("spool_create_item", { title: "with a date", deadlineLabel: "Sep 2", deadlineKind: "external" })).text,
  );
  const listed = JSON.parse((await call("spool_list_items", {})).text);
  expect(listed.items.find((i: { id: string }) => i.id === whole.id).deadline).toEqual({
    label: "Sep 2",
    kind: "external",
  });
});

test("chat-set focus reaches the same store the room polls — the loop closes", async () => {
  const client = await spool();
  const call = await masterTools(client);
  // Focus validates the subject against the map, so file something first.
  await call("spool_create_item", { title: "seed", subjectKey: "ozom-gv" });
  const refused = await call("spool_set_focus", { subjectKey: "nowhere" });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("ozom-gv");

  await call("spool_set_focus", { subjectKey: "ozom-gv", note: "creating tasks" });
  const { pickup } = await client.spoolFocus();
  expect(pickup.current.map((e) => e.subject)).toEqual(["ozom-gv"]);

  await call("spool_end_focus", { reason: "paused" });
  const after = await client.spoolFocus();
  expect(after.pickup.current).toEqual([]);
});

test("the question verbs bind to the store's laws across HTTP: open, mark, settle", async () => {
  const client = await spool();
  const call = await masterTools(client);

  const floating = JSON.parse((await call("spool_create_item", { title: "unfiled words" })).text);
  const refused = await call("spool_open_question", { itemId: floating.id, question: "Whose?" });
  expect(refused.isError).toBe(true);
  expect(refused.text).toContain("floating");

  const filed = JSON.parse((await call("spool_create_item", { title: "does parity hold", subjectKey: "ozom-gv" })).text);
  const opened = JSON.parse(
    (await call("spool_open_question", {
      itemId: filed.id,
      question: "Does our reported data match the platforms?",
      handle: "Supermetrics parity",
      stuckOn: "person",
      who: "Ana",
      stuckNote: "owes the live numbers",
    })).text,
  );
  expect(opened.subject).toBe("ozom-gv");
  expect(opened.stuckOn).toMatchObject({ kind: "person", who: "Ana" });

  // Mark by CAPTURE id — the tool resolves the claiming thread.
  const marked = JSON.parse((await call("spool_mark_waiting", { itemId: filed.id, stuckOn: "you" })).text);
  expect(marked.threadId).toBe(opened.threadId);
  expect(marked.stuckOn.kind).toBe("you");

  const emptySettle = await call("spool_settle_thread", { threadId: opened.threadId, answer: "   " });
  expect(emptySettle.isError).toBe(true);

  const settled = JSON.parse(
    (await call("spool_settle_thread", { threadId: opened.threadId, answer: "Meta diverges 6.83%; Google matches." })).text,
  );
  expect(settled.settled).toContain("6.83%");
  // Settled means not stuck on anyone — the mark now refuses.
  const remark = await call("spool_mark_waiting", { threadId: opened.threadId, stuckOn: "agent" });
  expect(remark.isError).toBe(true);
});

// ── terrain and looks over HTTP — loop 1's seam ─────────────────────────────

test("terrain sets, clears, and refuses a bad address with the store's own sentence", async () => {
  const client = await spool();
  await client.createSpoolItem({ title: "seed", project: "ozom-gv" });

  const { subject } = await client.setSpoolSubjectTerrain("ozom-gv", {
    kind: "github-repo",
    repo: "ozom-ai/ozom-gv",
    notes: "milestones are Hitos",
  });
  expect(subject.terrain).toEqual({ kind: "github-repo", repo: "ozom-ai/ozom-gv", notes: "milestones are Hitos" });
  // Read back through the ordinary subjects read — one record, not a copy.
  const listed = await client.spoolSubjects();
  expect(listed.subjects.find((s) => s.key === "ozom-gv")!.terrain!.repo).toBe("ozom-ai/ozom-gv");

  // The refusal crosses HTTP with the guard's sentence, because the sentence
  // names the shape ("owner/name") and a bare 400 would not.
  const bad = client.setSpoolSubjectTerrain("ozom-gv", { kind: "github-repo", repo: "not a repo" });
  await expect(bad).rejects.toThrow(/owner\/name/);

  const cleared = await client.setSpoolSubjectTerrain("ozom-gv", null);
  expect(cleared.subject.terrain).toBeUndefined();

  await expect(client.setSpoolSubjectTerrain("nope", null)).rejects.toBeInstanceOf(EngineClientError);
});

test("identity sets, clears field by field, and refuses bad values with the store's own sentences", async () => {
  const client = await spool();
  // The subject exists because the human filed an item to it — the auto-create
  // path — and identity is stated AFTERWARD; creation itself takes none.
  await client.createSpoolItem({ title: "arreglar la caldera", project: "casa" });

  const { subject } = await client.setSpoolSubjectIdentity("casa", { area: "Personal", color: "sea" });
  expect(subject.area).toBe("Personal");
  expect(subject.color).toBe("sea");
  // Read back through the ordinary subjects read — one record, not a copy.
  // This is ALSO the carry-through: every view that shows subject metadata
  // joins this list by key, exactly as terrain and permits already do.
  const listed = await client.spoolSubjects();
  expect(listed.subjects.find((s) => s.key === "casa")).toMatchObject({ area: "Personal", color: "sea" });

  // One field per statement leaves the other alone; null withdraws.
  const recolored = await client.setSpoolSubjectIdentity("casa", { color: "plum" });
  expect(recolored.subject).toMatchObject({ area: "Personal", color: "plum" });
  const cleared = await client.setSpoolSubjectIdentity("casa", { area: null });
  expect(cleared.subject.area).toBeUndefined();
  expect(cleared.subject.color).toBe("plum");

  // The refusals cross HTTP with the store's sentences — the closed color set
  // and the area cap are named, not summarized into a bare 400.
  await expect(client.setSpoolSubjectIdentity("casa", { color: "#ff0000" as never })).rejects.toThrow(/never a hex value/);
  await expect(client.setSpoolSubjectIdentity("casa", { area: "   " })).rejects.toThrow(/`null` to clear/);
  await expect(client.setSpoolSubjectIdentity("casa", { area: "x".repeat(200) })).rejects.toThrow(/short group name/);

  await expect(client.setSpoolSubjectIdentity("nope", { area: "Trabajo" })).rejects.toBeInstanceOf(EngineClientError);
});

test("rank round-trips through the same identity PATCH, and setting area never clears it", async () => {
  const client = await spool();
  await client.createSpoolItem({ title: "arreglar la caldera", project: "casa" });

  const { subject } = await client.setSpoolSubjectIdentity("casa", { rank: 2 });
  expect(subject.rank).toBe(2);
  const listed = await client.spoolSubjects();
  expect(listed.subjects.find((s) => s.key === "casa")).toMatchObject({ rank: 2 });

  // Moving areas is a different statement — it must not touch a rank the
  // human already set.
  const moved = await client.setSpoolSubjectIdentity("casa", { area: "Personal" });
  expect(moved.subject.area).toBe("Personal");
  expect(moved.subject.rank).toBe(2);

  const cleared = await client.setSpoolSubjectIdentity("casa", { rank: null });
  expect(cleared.subject.rank).toBeUndefined();

  // Refused verbatim, in the store's own sentence, and nothing is written.
  // (`NaN`/`Infinity` are not JSON-representable, so the over-the-wire
  // refusal is exercised with a negative number; the non-finite arms are
  // covered directly against the store in `spool-subjects.test.ts`.)
  await expect(client.setSpoolSubjectIdentity("casa", { rank: -1 })).rejects.toThrow(/finite number/);
  expect((await client.spoolSubjects()).subjects.find((s) => s.key === "casa")!.rank).toBeUndefined();
});

test("look: baseline, delta, acknowledge — pull-only, over the real routes", async () => {
  const { state, gh } = movableWorld();
  const client = await spool({ gh });
  await client.createSpoolItem({ title: "tools de escritura", project: "ozom-gv" });
  await client.setSpoolSubjectTerrain("ozom-gv", { kind: "github-repo", repo: "ozom-ai/ozom-gv" });

  state.pulls = [{ number: 420, title: "identidad", state: "OPEN", updatedAt: "t", url: "u", assignees: [], author: { login: "ana" } }];
  const first = await client.reconcileSpoolLook("ozom-gv");
  expect(first.look.fresh).toBe(true);
  expect(first.look.look!.observations.map((o) => o.text)).toEqual([
    expect.stringContaining("baseline recorded"),
  ]);

  // The world moves — a merge the user, a session or a teammate made; the
  // look does not care which.
  state.pulls = [{ ...(state.pulls[0] as object), state: "MERGED" }];
  const second = await client.reconcileSpoolLook("ozom-gv");
  const texts = second.look.look!.observations.map((o) => o.text);
  expect(texts).toContain("PR #420 merged since your last look.");

  // The stored reads answer without touching gh, and say so via fresh: false.
  const stored = await client.spoolLook("ozom-gv");
  expect(stored.look.fresh).toBe(false);
  expect(stored.look.look!.observations.map((o) => o.text)).toEqual(texts);
  expect((await client.spoolLooks()).looks.map((l) => l.subject)).toContain("ozom-gv");

  // "Noted" drains — the row stays, marked. An unknown id is a 404.
  const merged = second.look.look!.observations.find((o) => o.text.includes("merged"))!;
  const drained = await client.acknowledgeSpoolObservation("ozom-gv", merged.id);
  expect(drained.look.observations.find((o) => o.id === merged.id)!.acknowledged).toBe(true);
  expect(drained.look.observations).toHaveLength(second.look.look!.observations.length);
  await expect(client.acknowledgeSpoolObservation("ozom-gv", "o-nope")).rejects.toBeInstanceOf(EngineClientError);
});

test("a look at a terrain-less subject and at an unknown subject answer differently", async () => {
  const client = await spool({
    gh: async () => {
      throw new Error("a terrain-less subject must never reach gh");
    },
  });
  await client.createSpoolItem({ title: "essay outline", project: "school" });

  // No terrain: an ordinary answer carrying a note — the no-code test at the
  // HTTP seam.
  const { look } = await client.reconcileSpoolLook("school");
  expect(look.fresh).toBe(false);
  expect(look.note).toContain("no terrain");
  expect(look.error).toBeUndefined();

  // No subject: an actual 404 — there is nothing to answer about.
  await expect(client.reconcileSpoolLook("nowhere")).rejects.toBeInstanceOf(EngineClientError);
});

test("gh failing crosses the route as a stale answer, never a 5xx", async () => {
  const client = await spool({ gh: async () => ({ status: 1, stdout: "", stderr: "error connecting to api.github.com" }) });
  await client.createSpoolItem({ title: "seed", project: "ozom-gv" });
  await client.setSpoolSubjectTerrain("ozom-gv", { kind: "github-repo", repo: "ozom-ai/ozom-gv" });

  const { look } = await client.reconcileSpoolLook("ozom-gv");
  expect(look.fresh).toBe(false);
  expect(look.error).toContain("Could not look at ozom-ai/ozom-gv");
});

// ── the briefing route — loop 2's seam ──────────────────────────────────────

test("the briefing composes packet, thread state and the look delta, and resolves the project", async () => {
  const { state, gh } = movableWorld();
  const client = await spool({ gh });
  const root = roots[roots.length - 1]!;
  // A registered project whose name matches the subject — the same pairing
  // deriveSubjects records.
  const { project } = await client.registerProject({ name: "ozom-gv", root });

  const { item } = await client.createSpoolItem({
    title: "presupuestos sept no cuadran",
    project: "ozom-gv",
    raw: "los presupuestos de sept no cuadran, revisar antes del cierre",
  });
  await client.setSpoolSubjectTerrain("ozom-gv", { kind: "github-repo", repo: "ozom-ai/ozom-gv" });
  await client.reconcileSpoolLook("ozom-gv");
  state.issues = [{ number: 427, title: "identidad", state: "OPEN", updatedAt: "t", url: "u", milestone: { title: "Hito 1" }, assignees: [], author: { login: "ana" } }];
  await client.reconcileSpoolLook("ozom-gv");
  await client.openSpoolThread("ozom-gv", { question: "Do the budgets match the tracker?", items: [item.id] });

  const { briefing } = await client.spoolBriefing(item.id);
  expect(briefing.itemId).toBe(item.id);
  expect(briefing.subject).toBe("ozom-gv");
  // The web navigates on this — the whole point of the route.
  expect(briefing.project).toEqual({ id: project.id, name: "ozom-gv" });
  expect(briefing.briefing).toContain("> los presupuestos de sept no cuadran");
  expect(briefing.briefing).toContain("Do the budgets match the tracker?");
  expect(briefing.briefing).toContain('ana opened #427 ("identidad") and added it to Hito 1.');
  expect(briefing.freshness!.observations.some((o) => o.text.includes("#427"))).toBe(true);
});

test("a subject with no registered project briefs honestly with `project` absent", async () => {
  // The honest structured answer, not an invented project: the web renders its
  // existing "no registered project matches" branch off this absence.
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "essay outline", project: "school", raw: "outline the essay" });

  const { briefing } = await client.spoolBriefing(item.id);
  expect(briefing.subject).toBe("school");
  expect(briefing.project).toBeUndefined();
  expect(briefing.briefing).toContain("> outline the essay");

  await expect(client.spoolBriefing("i-nothing")).rejects.toBeInstanceOf(EngineClientError);
});

// ── whose hand filed it — the conservation line stays honest ────────────────

test("a human-API create does not count into agentsAdded; a create through the tool wall does", async () => {
  // The live-drive lie this pins down: 14 hand-and-agent items rendered as
  // "14 items · agents added 14". The count must follow the HAND, and the only
  // caller that may declare an agent's hand is the toolkit's own code — a bare
  // POST to the human route is the workbench form and stamps "you".
  const client = await spool();
  const call = await masterTools(client);

  const { item: byHand } = await client.createSpoolItem({ title: "made on the workbench" });
  expect(byHand.provenance).toBe("you");
  // The timeline says so too, in the actor the enum always had for the human.
  expect(byHand.timeline![0]!.actor).toBe("you");
  expect(byHand.timeline![0]!.text).toBe("captured by hand");

  let snapshot = await client.spool();
  expect(snapshot.totalItems).toBe(1);
  expect(snapshot.agentsAdded).toBe(0);

  const filed = JSON.parse((await call("spool_create_item", { title: "filed by an agent" })).text);
  expect(filed.provenance).toBe("session");

  snapshot = await client.spool();
  expect(snapshot.totalItems).toBe(2);
  expect(snapshot.agentsAdded).toBe(1);
});

// ── the pin over HTTP — the workbench writes the user's own day by hand ─────

test("a pin rides create and update, and reaches every view the surfaces read — including the briefing's quiet quote", async () => {
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "hand-made", project: "aurora", pinned: { day: "2026-08-19" } });
  expect(item.pinned).toEqual({ day: "2026-08-19" });

  // One snapshot, both axes: the desk card and the subject row carry the pin,
  // so the board and the calendar draw it with no second join.
  const snapshot = await client.spool();
  expect(snapshot.desk.find((d) => d.id === item.id)!.pinned).toEqual({ day: "2026-08-19" });
  const aurora = snapshot.subjects.find((g) => g.project === "aurora")!;
  expect(aurora.rows.find((r) => r.item.id === item.id)!.item.pinned).toEqual({ day: "2026-08-19" });

  // The briefing QUOTES the pin — a statement of the user's own placement,
  // never a countdown or an "overdue".
  const { briefing } = await client.spoolBriefing(item.id);
  expect(briefing.briefing).toContain("The user pinned this to 2026-08-19.");

  // Dragged to another day: the same update path as everything human-owned.
  const moved = await client.updateSpoolItem(item.id, { pinned: { day: "2026-08-21" } });
  expect(moved.item.pinned).toEqual({ day: "2026-08-21" });

  // Cleared by an EXPLICIT null — the pin goes, the item stays.
  const cleared = await client.updateSpoolItem(item.id, { pinned: null });
  expect(cleared.item.pinned).toBeUndefined();
  expect((await client.spoolItem(item.id)).item.title).toBe("hand-made");
});

test("a day the user did not write out is a 400 CARRYING the store's sentence, and nothing is written", async () => {
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "target" });

  await expect(client.updateSpoolItem(item.id, { pinned: { day: "Friday" } })).rejects.toThrow(/write the actual date/);
  await expect(client.updateSpoolItem(item.id, { pinned: { day: "2026-02-30" } })).rejects.toThrow(/not a day on the calendar/);
  await expect(client.createSpoolItem({ title: "never lands", pinned: { day: "tomorrow" } })).rejects.toThrow(/YYYY-MM-DD/);

  expect((await client.spoolItem(item.id)).item.pinned).toBeUndefined();
});

test("terrain and look reach the chat through the tool wall — record it, then glance", async () => {
  const { state, gh } = movableWorld();
  const client = await spool({ gh });
  const call = await masterTools(client);
  await call("spool_create_item", { title: "seed", subjectKey: "ozom-gv" });

  const recorded = JSON.parse(
    (await call("spool_set_terrain", { subjectKey: "ozom-gv", repo: "ozom-ai/ozom-gv", notes: "milestones are Hitos" })).text,
  );
  expect(recorded.terrain.repo).toBe("ozom-ai/ozom-gv");

  state.issues = [{ number: 1, title: "x", state: "OPEN", updatedAt: "t", url: "u", assignees: [], author: { login: "ana" } }];
  const looked = JSON.parse((await call("spool_look", { subjectKey: "ozom-gv" })).text);
  expect(looked.repo).toBe("ozom-ai/ozom-gv");
  expect(looked.fresh).toBe(true);
  expect(looked.observations.map((o: { text: string }) => o.text)).toEqual([
    expect.stringContaining("baseline recorded"),
  ]);

  // A bad address refuses through the wall with the guard's sentence.
  const bad = await call("spool_set_terrain", { subjectKey: "ozom-gv", repo: "not a repo" });
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain("owner/name");

  // Withdrawn in conversation — and a look afterwards says there is nowhere
  // to look, rather than erroring.
  const cleared = JSON.parse((await call("spool_set_terrain", { subjectKey: "ozom-gv", clear: true })).text);
  expect(cleared.terrain).toBeNull();
  const nowhere = JSON.parse((await call("spool_look", { subjectKey: "ozom-gv" })).text);
  expect(nowhere.note).toContain("no terrain");
});

test("identity reaches the chat through the tool wall — the user's words land on the real record", async () => {
  const client = await spool();
  const call = await masterTools(client);
  await call("spool_create_item", { title: "arreglar la caldera", subjectKey: "casa" });

  // "pon casa en el área personal, de color mar" — one statement, both fields.
  const recorded = JSON.parse(
    (await call("spool_set_subject_identity", { subjectKey: "casa", area: "Personal", color: "sea" })).text,
  );
  expect(recorded.area).toBe("Personal");
  expect(recorded.color).toBe("sea");
  expect(recorded.note).toContain("nothing about its urgency");

  // What the tool wrote is what every surface reads — the same subjects list.
  const listed = await client.spoolSubjects();
  expect(listed.subjects.find((s) => s.key === "casa")).toMatchObject({ area: "Personal", color: "sea" });

  // An overlong area refuses through the wall with the store's sentence.
  const bad = await call("spool_set_subject_identity", { subjectKey: "casa", area: "x".repeat(200) });
  expect(bad.isError).toBe(true);
  expect(bad.text).toContain("short group name");

  // Withdrawn in conversation, one field at a time.
  const cleared = JSON.parse((await call("spool_set_subject_identity", { subjectKey: "casa", clearColor: true })).text);
  expect(cleared.color).toBeNull();
  expect(cleared.area).toBe("Personal");
});

test("the aperture is ONE slot over HTTP — read defaults wide, PUT replaces, a stray view is a 400 with the sentence", async () => {
  const client = await spool();

  // Never written is the ordinary wide room, not a 404.
  expect((await client.spoolAperture()).aperture).toEqual({ view: "everything", schemaVersion: 1 });

  // PUT replaces the whole value — the hand's click and the chat's tool share
  // this slot, so the write answers with the slot as it now stands.
  expect((await client.setSpoolAperture("today")).aperture.view).toBe("today");
  expect((await client.spoolAperture()).aperture.view).toBe("today");

  // Last writer wins, idempotently — no history for anything to disagree with.
  await client.setSpoolAperture("scheduled");
  await client.setSpoolAperture("scheduled");
  expect((await client.spoolAperture()).aperture.view).toBe("scheduled");

  // The closed set refuses with the store's sentence, and the slot is untouched.
  await expect(client.setSpoolAperture("urgent" as never)).rejects.toThrow(/not a view the room has/);
  expect((await client.spoolAperture()).aperture.view).toBe("scheduled");
});

test("area ceilings over HTTP — stated lazily, joinable by name, clamping the threads read, withdrawn without deletion", async () => {
  const client = await spool();
  await client.createSpoolItem({ title: "arreglar la caldera", project: "casa" });
  await client.setSpoolSubjectIdentity("casa", { area: "Personal" });

  // Naming the area on a subject minted NO record — ceilings are stated, never
  // assumed, "Personal" included.
  expect((await client.spoolAreas()).areas).toEqual([]);
  expect((await client.spoolThreads("casa")).permits).toBe("draft");

  const stated = await client.setSpoolAreaCeiling("Personal", "read");
  expect(stated.area).toMatchObject({ name: "Personal", ceiling: "read" });
  // Listed for the join: the web pairs this by `name` against `subject.area`.
  expect((await client.spoolAreas()).areas.map((a) => [a.name, a.ceiling])).toEqual([["Personal", "read"]]);

  // THE ENFORCEMENT READ over the same wire: the map now reports the clamped
  // level, while the subject record keeps what it states — effective vs stated.
  expect((await client.spoolThreads("casa")).permits).toBe("read");
  expect((await client.spoolSubjects()).subjects.find((s) => s.key === "casa")!.permits).toBe("draft");

  // A level outside the enum is a 400 carrying the plain sentence.
  await expect(client.setSpoolAreaCeiling("Personal", "urgent" as never)).rejects.toThrow(/ceiling must be/);

  // `null` withdraws the statement; the record stays — no delete path.
  const cleared = await client.setSpoolAreaCeiling("Personal", null);
  expect(cleared.area.ceiling).toBeUndefined();
  expect((await client.spoolAreas()).areas.map((a) => a.name)).toEqual(["Personal"]);
  expect((await client.spoolThreads("casa")).permits).toBe("draft");
});

test("area ceilings reach the chat through the tool wall — the user's own words land on the real record", async () => {
  const client = await spool();
  const call = await masterTools(client);
  await call("spool_create_item", { title: "arreglar la caldera", subjectKey: "casa" });
  await call("spool_set_subject_identity", { subjectKey: "casa", area: "Personal" });

  // "Personal nunca se trabaja sin preguntar" → a ceiling on the real record,
  // read back through every surface's own routes.
  const clamped = JSON.parse((await call("spool_set_area_permits", { area: "Personal", ceiling: "read" })).text);
  expect(clamped.ceiling).toBe("read");
  expect(clamped.note).toContain("never raises");
  expect((await client.spoolThreads("casa")).permits).toBe("read");

  const badLevel = await call("spool_set_area_permits", { area: "Personal", ceiling: "urgent" });
  expect(badLevel.isError).toBe(true);
  expect(badLevel.text).toContain("not a permit level");

  const withdrawn = JSON.parse((await call("spool_set_area_permits", { area: "Personal", clear: true })).text);
  expect(withdrawn.ceiling).toBeNull();
  expect((await client.spoolThreads("casa")).permits).toBe("draft");
});

test("tags ride create and patch through the one gate; [] clears to absence; a blank tag is a sentence, not a drop", async () => {
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "cuadrar facturación", tags: ["facturación", " facturación ", "q3"] });
  // Trimmed, deduped, order kept — the gate's work, visible at the seam.
  expect(item.tags).toEqual(["facturación", "q3"]);

  const retagged = (await client.updateSpoolItem(item.id, { tags: ["no tocar"] })).item;
  expect(retagged.tags).toEqual(["no tocar"]);

  // The whole list replaced; [] clears to ABSENCE, the schema's only spelling
  // of "no tags" — same as the pin's.
  const cleared = (await client.updateSpoolItem(item.id, { tags: [] })).item;
  expect(cleared.tags).toBeUndefined();

  await expect(client.createSpoolItem({ title: "x", tags: [" "] })).rejects.toThrow(/tag/i);
  await expect(client.updateSpoolItem(item.id, { tags: [42] } as never)).rejects.toThrow(/tag/i);
});

test("the search route finds an item by its tag, subject-narrowed and limited by the query string", async () => {
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "cerrar prensa", project: "ozom-gv", tags: ["facturación"] });
  await client.createSpoolItem({ title: "otra cosa", project: "aurora" });

  const { hits } = await client.spoolSearch("facturacion", { subject: "ozom-gv", limit: 5 });
  expect(hits.map((h) => [h.kind, h.id, h.subject])).toEqual([["item", item.id, "ozom-gv"]]);
  // An empty query is a search for nothing, answered honestly — not an error.
  expect((await client.spoolSearch("")).hits).toEqual([]);
});

test("the digest rides the look outcome, and ack-all drains a whole group in one idempotent gesture", async () => {
  const { state, gh } = movableWorld();
  const client = await spool({ gh });
  const { item: mirroredItem } = await client.createSpoolItem({ title: "identidad", project: "ozom-gv" });
  await client.updateSpoolItem(mirroredItem.id, { mirrored: "#420" });
  await client.setSpoolSubjectTerrain("ozom-gv", { kind: "github-repo", repo: "ozom-ai/ozom-gv" });

  state.pulls = [{ number: 420, title: "identidad", state: "OPEN", updatedAt: "t", url: "u", assignees: [], author: { login: "ana" } }];
  await client.reconcileSpoolLook("ozom-gv");
  state.pulls = [{ ...(state.pulls[0] as object), state: "MERGED" }];
  const { look } = await client.reconcileSpoolLook("ozom-gv");

  // COMPRESSED, never multiplied: two observations (the baseline and the
  // merge), and the digest is lines-per-group, each carrying its ids. The
  // item sits in the seed lane, so the merge groups under "Unfiled".
  expect(look.digest).toBeDefined();
  const allIds = look.digest!.flatMap((line) => line.observationIds);
  expect(allIds.sort()).toEqual(look.look!.observations.map((o) => o.id).sort());
  expect(look.digest!.map((line) => line.text)).toEqual([
    "Unfiled — 1 PR merged",
    "ozom-gv — 1 note",
  ]);

  // One gesture drains the whole group — idempotent, unknown ids skipped.
  const drained = await client.acknowledgeSpoolObservations("ozom-gv", [...allIds, "o-junk"]);
  expect(drained.acknowledged).toBe(allIds.length);
  expect(drained.look.observations.every((o) => o.acknowledged)).toBe(true);
  expect((await client.acknowledgeSpoolObservations("ozom-gv", allIds)).acknowledged).toBe(allIds.length ? allIds.length : 0);

  // Fully drained means NO digest — absence, not an empty array.
  expect((await client.spoolLook("ozom-gv")).look.digest).toBeUndefined();

  // A subject with no recorded look is a 404; nothing is minted to ack into.
  await client.createSpoolItem({ title: "essay", project: "school" });
  await expect(client.acknowledgeSpoolObservations("school", ["o-1"])).rejects.toBeInstanceOf(EngineClientError);
});

test("settle-many: every answer required, per-thread refusals beside the settles, never a thrown batch", async () => {
  const client = await spool();
  const { item } = await client.createSpoolItem({ title: "presupuestos sept", project: "ozom-gv", raw: "no cuadran" });
  const { item: other } = await client.createSpoolItem({ title: "tracker access", project: "ozom-gv" });
  const a = (await client.openSpoolThread("ozom-gv", { question: "does our ad data match?", items: [item.id] })).thread;
  const b = (await client.openSpoolThread("ozom-gv", { question: "who owns the tracker?", items: [other.id] })).thread;

  const first = await client.settleSpoolThreadsMany("ozom-gv", [
    { threadId: a.id, answer: "no — Meta diverges 6.83%" },
    { threadId: b.id, answer: "   " },
    { threadId: "t-none", answer: "irrelevant" },
  ]);
  expect(first.settled.map((t) => t.id)).toEqual([a.id]);
  expect(first.settled[0]!.settled!.answer).toBe("no — Meta diverges 6.83%");
  // Each refusal carries ITS sentence: the empty answer keeps the store's
  // status-flip refusal, the unknown id names itself.
  expect(first.refused.map((r) => r.threadId)).toEqual([b.id, "t-none"]);
  expect(first.refused[0]!.reason).toContain("status flip");
  expect(first.refused[1]!.reason).toContain("t-none");

  // A named already-settled thread refuses with what it already holds —
  // never overwritten.
  const again = await client.settleSpoolThreadsMany("ozom-gv", [{ threadId: a.id, answer: "different" }]);
  expect(again.settled).toEqual([]);
  expect(again.refused[0]!.reason).toContain("Meta diverges 6.83%");

  // A body that is not even the right shape is the one 400.
  await expect(client.settleSpoolThreadsMany("ozom-gv", "nope" as never)).rejects.toBeInstanceOf(EngineClientError);
});

test("close-many: the single close's cascade and shape per id, errors per row, and the batch never throws over one", async () => {
  const client = await spool();
  const { item: first } = await client.createSpoolItem({ title: "paridad", project: "ozom-gv" });
  const { item: second } = await client.createSpoolItem({ title: "floating one" });
  const thread = (await client.openSpoolThread("ozom-gv", { question: "cuadra?", items: [first.id] })).thread;

  const { results } = await client.closeSpoolItems([first.id, second.id, "i-none"]);
  expect(results.map((r) => r.id)).toEqual([first.id, second.id, "i-none"]);

  // Per item, EXACTLY the single verb's shape: stamp, cascade, refusals.
  expect(results[0]!.item!.closed).toBeDefined();
  expect(results[0]!.settledThreads!.map((t) => t.id)).toEqual([thread.id]);
  expect(results[0]!.settledThreads![0]!.settled!.answer).toBe("the user closed the task");
  expect(results[0]!.refused).toEqual([]);
  expect(results[1]!.item!.closed).toBeDefined();
  expect(results[1]!.settledThreads).toEqual([]);
  // The stale third id is an error BESIDE the closes that landed.
  expect(results[2]!.error).toBe("spool item not found");
  expect(results[2]!.item).toBeUndefined();

  // Idempotent like its parts: a repeat says "already closed" per row.
  const repeat = await client.closeSpoolItems([first.id]);
  expect(repeat.results[0]!.note).toContain("Already closed");
});
