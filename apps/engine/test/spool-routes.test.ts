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

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

async function spool(): Promise<EngineClient> {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-spool-routes-"));
  roots.push(directory);
  const daemon = await startEngine({ engineRoot: directory });
  daemons.push(daemon);
  return new EngineClient(daemon.discovery);
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

  expect(item.provenance).toBe("session"); // stamped server-side, never from input
  expect(item.desk).toBe(true);

  const snapshot = await client.spool();
  expect(snapshot.lanes.map((l) => l.key)).toEqual(["unfiled"]); // the ensure step seeded it
  expect(snapshot.rows.map((r) => [r.lane, r.rank, r.item.id])).toEqual([["unfiled", 1, item.id]]);
  expect(snapshot.desk.map((d) => d.id)).toEqual([item.id]);
  expect(snapshot.totalItems).toBe(1);
  expect(snapshot.agentsAdded).toBe(1);
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

  // A SINGLETON. Calling twice returns the same session rather than a second
  // front door — "one project-less conversation" is the contract, and a list of
  // front doors is not one.
  const again = await client.spoolMaster();
  expect(again.session.id).toBe(session.id);

  // …and it holds no store files: lanes.json and packets/ are its SIBLINGS.
  expect(fs.readdirSync(session.workspace.path)).toEqual([]);
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
