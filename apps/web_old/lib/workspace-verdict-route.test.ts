// The human-verdict endpoint (story 5.8 / CAP-9) —
// app/api/workspace/items/[id]/verdict/route.ts.
//
// WHY THE FILE LIVES HERE and not beside the route: nothing under app/ carries a
// test in this repo — Next's own file conventions own that directory — so
// workspace-weave-route.test.ts's placement is the precedent, and the route is
// imported BY PATH below so moving it breaks this file loudly rather than
// silently orphaning it.
//
// WHAT IS UNDER TEST is the thin layer the route adds: the verb, the argument
// validation, the 400/404 split, and — the one that matters — that it reaches
// core's setItemVerdict and NOT updateItem. The durability itself
// (`verdictOverride`, and a later expert pass refusing to re-flip it) is proved
// on real disk in packages/core/test/workspace-expert.test.ts; what a route test
// can prove is that the human's click lands on the verb that sets the durable
// flag, because a route that "worked" through updateItem would write a verdict
// the next pass is allowed to overwrite.
//
// HARNESS: workspace-weave-route.test.ts's, exactly — mock.module is
// process-global, so the real namespace is snapshotted and restored, and the last
// test is a vacuity guard. NO STATE ROOT IS TOUCHED.
// @ts-expect-error no @types/bun in this workspace
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import * as realCore from "@telar/core";

const realCoreSnapshot = { ...realCore };

type FakeItem = Record<string, unknown> & { id: string; title: string };

let items: FakeItem[] = [];
// Every call each verb received, so a test can assert on WHICH verb ran as well
// as on what came back — the whole point of this suite.
let verdictCalls: Array<{ id: string; verdict: string }> = [];
let updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];
// THE VERB'S OWN THROW, as a switch. The real setItemVerdict runs
// assertPacketAddressMatches and Item.parse, either of which throws — and a stub
// that can only return null cannot exercise the route's translation of that,
// which is how the missing try/catch went unnoticed. The message is the real
// store's, remediation clause included, because that clause is what the user
// acts on.
let verdictThrows: string | null = null;

mock.module("@telar/core", () => ({
  // The durable writer. Mirrors store.ts's contract: null for an unknown id,
  // a throw for a packet whose address does not match its content, and the flag
  // goes up beside the field — a stub that set only `verdict` would let a route
  // wired to the wrong verb pass this suite.
  setItemVerdict: (id: string, verdict: string) => {
    verdictCalls.push({ id, verdict });
    if (verdictThrows) throw new Error(verdictThrows);
    const item = items.find((i) => i.id === id);
    if (!item) return null;
    item.verdict = verdict;
    item.verdictOverride = true;
    item.timeline = [
      ...((item.timeline as unknown[]) ?? []),
      { at: "Tue 16:42", actor: "you", text: `verdict set to ${verdict}` },
    ];
    return item;
  },
  // STUBBED PURELY AS A TRIPWIRE. Nothing in this route may reach the generic
  // patch verb; if it ever does, `updateCalls` says so out loud instead of the
  // suite passing because the item came back looking right either way.
  updateItem: (id: string, patch: Record<string, unknown>) => {
    updateCalls.push({ id, patch });
    return items.find((i) => i.id === id) ?? null;
  },
}));

afterAll(() => {
  mock.module("@telar/core", () => realCoreSnapshot);
});

const route = (await import("../app/api/workspace/items/[id]/verdict/route")) as unknown as {
  POST: (req: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
  dynamic: string;
};

const post = (id: string, body: unknown, raw?: string) =>
  route.POST(
    new Request(`http://telar.local/api/workspace/items/${id}/verdict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: raw ?? JSON.stringify(body),
    }),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  items = [
    {
      id: "i-a1",
      title: "Exports: CSV",
      project: "aurora",
      provenance: "note",
      captured: "Tue 16:42",
      schemaVersion: 1,
      // The expert's advisory reading, already on the item. The human is about
      // to disagree with it, which is the case this whole route exists for.
      verdict: "loom",
    },
  ];
  verdictCalls = [];
  updateCalls = [];
  verdictThrows = null;
});

describe("POST /api/workspace/items/<id>/verdict", () => {
  test("a human's verdict goes through setItemVerdict, which is what makes it durable", async () => {
    const res = await post("i-a1", { verdict: "session" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { item: FakeItem };
    expect(body.item.verdict).toBe("session");
    // THE DURABLE FLAG, not merely the field. `verdictOverride` is what a later
    // expert pass reads before deciding whether it may write a verdict at all.
    expect(body.item.verdictOverride).toBe(true);
    expect(verdictCalls).toEqual([{ id: "i-a1", verdict: "session" }]);
    // AND NOT THE GENERIC PATCH VERB. A verdict written through updateItem
    // would set the field with no flag — precisely the verdict CAP-9 says a
    // later pass may overwrite.
    expect(updateCalls).toEqual([]);
  });

  test("the timeline records it as the human's own, so the next pass can read it", async () => {
    const res = await post("i-a1", { verdict: "session" });
    const body = (await res.json()) as { item: { timeline: Array<{ actor: string; text: string }> } };
    const last = body.item.timeline.at(-1)!;
    expect(last.actor).toBe("you");
    expect(last.text).toContain("session");
    // No `proposal` marker: a proposal means "an agent wrote this and nobody
    // has looked", which for a human's own click would be false.
    expect(last).not.toHaveProperty("proposal");
  });

  test("only the two verdicts the shape admits are accepted, and a rejection writes nothing", async () => {
    for (const body of [{ verdict: "maybe" }, { verdict: 7 }, {}, null]) {
      const res = await post("i-a1", body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain("session");
    }
    const malformed = await post("i-a1", undefined, "{ not json");
    expect(malformed.status).toBe(400);
    expect(verdictCalls).toEqual([]);
  });

  test("a body carrying anything but `verdict` is a 400, as the sibling PATCH's is", async () => {
    // PATCH in the same directory 400s every key outside its allow-list; a route
    // that silently dropped `{verdict, verdictOverride:false}` — or a `deadline`
    // some later surface posted here by mistake — would report success for a write
    // it never made.
    const res = await post("i-a1", { verdict: "session", verdictOverride: false });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("verdictOverride");
    expect(verdictCalls).toEqual([]);
  });

  test("a THROWING store verb is a 400 carrying the store's own remediation, not an unhandled 500", async () => {
    // AD-6 INVITES the state this covers: a packet is a hand-editable file, so its
    // `id:` line can disagree with the directory it sits in, and setItemVerdict's
    // assertPacketAddressMatches throws exactly then. The sibling PATCH turns that
    // into a 400 carrying the sentence that names the repair; through this route it
    // used to be an unhandled 500, which the packet view renders as "The verdict did
    // not change" with nothing to act on.
    verdictThrows =
      "AD-6: packets/i-a1/packet.yaml carries `id: \"i-other\"`, which is not the directory it sits in. " +
      "Nothing was written. Fix the `id:` line by hand, or move the directory.";
    const res = await post("i-a1", { verdict: "session" });
    expect(res.status).toBe(400);
    const error = ((await res.json()) as { error: string }).error;
    expect(error).toContain("AD-6");
    // THE REMEDIATION SURVIVES THE TRANSLATION. A route that replaced the store's
    // message with one of its own would drop the only sentence that tells the user
    // what to do.
    expect(error).toContain("Fix the `id:` line by hand");
    // The verb really was reached — the 400 is the store's refusal, not the
    // route's argument validation firing early.
    expect(verdictCalls).toEqual([{ id: "i-a1", verdict: "session" }]);
  });

  test("an unknown item is a 404, not a silent success", async () => {
    const res = await post("i-nope", { verdict: "loom" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: string }).error).toContain("not found");
  });

  test("the route is force-dynamic — a verdict page is never a cached one", () => {
    expect(route.dynamic).toBe("force-dynamic");
  });

  // VACUITY GUARD, workspace-weave-route.test.ts's. If the stub above were not
  // live, every assertion in this file would be about the operator's own state
  // root instead of the fake store.
  test("the stub really is what the route reached", async () => {
    const core = (await import("@telar/core")) as unknown as Record<string, unknown>;
    expect(typeof core.setItemVerdict).toBe("function");
    await post("i-a1", { verdict: "loom" });
    expect(verdictCalls.length).toBe(1);
  });
});
