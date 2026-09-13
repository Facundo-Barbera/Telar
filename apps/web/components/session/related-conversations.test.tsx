/**
 * THE AGENTS PANEL'S TWO SECTIONS — issue #381.
 *
 * What the rail's elbow could never say, said: WHICH errand, how it went, and
 * when. So these tests read for exactly that — the scope the coordinator named,
 * the outcome the errand reached, the state the row is in — and for the two
 * directions being two sections, because a delegate reading its own panel has a
 * different question from the coordinator reading theirs.
 *
 * THE DERIVATIONS ARE TESTED AS DERIVATIONS. `delegatesOf` and `coordinatorsOf`
 * are where the decisions live — which relationship names a row, what an
 * `unresolved` assignment is allowed to claim, whether a detached errand counts
 * — and a decision proved through a rendered string is a decision proved twice
 * as slowly and half as clearly. The render tests below check the PRESENTATION:
 * that each fact reaches the row, and that the control on it says the right verb.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Subscription } from "@telar/engine-client";
import { coordinatorsOf, delegatesOf, RelatedConversationsView } from "./related-conversations";
import type { SidebarSession } from "@/lib/session-list";

const NOW = 1_000_000_000;
const MINUTE = 60 * 1000;

const session = (id: string, extra: Partial<SidebarSession> = {}): SidebarSession =>
  ({ id, title: id, projectId: "p1", activity: "idle", createdAt: NOW - MINUTE, updatedAt: NOW, ...extra }) as SidebarSession;

const assignment = (from: string, extra: Record<string, unknown> = {}) =>
  ({ taskRunId: `task_${from}`, fromSessionId: from, receivedAt: NOW - MINUTE, runId: `task_${from}`, ...extra }) as never;

const subscription = (id: string, target: string): Subscription => ({
  id,
  subscriberSessionId: "coord",
  targetSessionId: target,
  events: ["turn_completed"],
  createdAt: NOW - MINUTE,
});

const view = (props: Partial<React.ComponentProps<typeof RelatedConversationsView>> = {}) =>
  renderToStaticMarkup(<RelatedConversationsView delegates={[]} employers={[]} now={NOW} {...props} />);

describe("delegatesOf", () => {
  test("an outstanding errand carries the scope the coordinator named, and when it was handed over", () => {
    const rows = [session("worker", { assignments: [assignment("coord", { scope: "apps/engine only" })] })];
    expect(delegatesOf(rows, { id: "coord" })).toEqual([
      { session: rows[0]!, kind: "assigned", scope: "apps/engine only", at: NOW - MINUTE, subscriptionIds: [] },
    ]);
  });

  test("a finished errand reports its OUTCOME, and the newest one when there were several", () => {
    // The row is reporting an errand, not a history: an old `failed` under a
    // recent `completed` would say the work failed.
    const rows = [
      session("worker", {
        assignments: [
          assignment("coord", { outcome: "failed", endedAt: NOW - 90 * MINUTE, scope: "first go" }),
          assignment("coord", { outcome: "completed", endedAt: NOW - 5 * MINUTE, scope: "second go" }),
        ],
      }),
    ];
    expect(delegatesOf(rows, { id: "coord" })).toMatchObject([
      { kind: "finished", outcome: "completed", scope: "second go", at: NOW - 5 * MINUTE },
    ]);
  });

  test("the scope shown is the OUTSTANDING errand's, never a finished one's words", () => {
    const rows = [
      session("worker", {
        assignments: [
          assignment("coord", { outcome: "completed", endedAt: NOW - 90 * MINUTE, scope: "last week's task" }),
          assignment("coord", { scope: "what it is doing now" }),
        ],
      }),
    ];
    expect(delegatesOf(rows, { id: "coord" })[0]).toMatchObject({ kind: "assigned", scope: "what it is doing now" });
  });

  test("provenance and a subscription are relationships too, and sort after the errands", () => {
    const rows = [
      session("free", { startedFrom: { sessionId: "coord" } }),
      session("busy", { assignments: [assignment("coord")] }),
      session("watched"),
    ];
    const out = delegatesOf(rows, { id: "coord" }, [subscription("sub_1", "watched")]);
    expect(out.map((entry) => [entry.session.id, entry.kind])).toEqual([
      ["busy", "assigned"],
      ["free", "started"],
      ["watched", "followed"],
    ]);
  });

  test("ONE ROW PER CONVERSATION: a followed delegate keeps its errand and gains the subscription", () => {
    // Two rows for one session would put the unfollow control on a duplicate.
    const rows = [session("worker", { assignments: [assignment("coord", { scope: "the parser" })] })];
    const out = delegatesOf(rows, { id: "coord" }, [subscription("sub_1", "worker"), subscription("sub_2", "worker")]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "assigned", scope: "the parser", subscriptionIds: ["sub_1", "sub_2"] });
  });

  test("a detached errand leaves the list without deleting provenance", () => {
    // "Continue independently": no longer anybody's work, still started here.
    const rows = [
      session("worker", { assignments: [assignment("coord", { outcome: "detached", endedAt: NOW })], startedFrom: { sessionId: "coord" } }),
    ];
    expect(delegatesOf(rows, { id: "coord" })).toMatchObject([{ kind: "started" }]);
  });

  test("HOST COLLISIONS gather no stranger, subscriptions included", () => {
    // Two Macs can mint one session id; `fromSessionId` and `targetSessionId`
    // are bare ids and mean something only within one engine.
    const rows = [session("worker", { hostId: "other-mac", assignments: [assignment("coord")] }), session("watched", { hostId: "other-mac" })];
    expect(delegatesOf(rows, { id: "coord" }, [subscription("sub_1", "watched")])).toEqual([]);
    expect(delegatesOf(rows, { id: "coord", hostId: "other-mac" }, [subscription("sub_1", "watched")])).toHaveLength(2);
  });

  test("a conversation never lists itself, however it is related", () => {
    const rows = [session("coord", { assignments: [assignment("coord")], startedFrom: { sessionId: "coord" } })];
    expect(delegatesOf(rows, { id: "coord" }, [subscription("sub_1", "coord")])).toEqual([]);
  });

  test("NOTHING AGES OUT. The rail's tree let go of a finished errand; a roster does not", () => {
    // #370's rule existed because an indent claimed live work. A row that says
    // "Done · 3w ago" claims nothing of the kind, and dropping it would hide
    // the result the coordinator delegated for.
    const rows = [
      session("worker", {
        assignments: [assignment("coord", { outcome: "completed", endedAt: NOW - 30_000 * MINUTE })],
        settledOverride: "settled",
        updatedAt: NOW - 30_000 * MINUTE,
      }),
    ];
    expect(delegatesOf(rows, { id: "coord" })).toMatchObject([{ kind: "finished", outcome: "completed" }]);
  });
});

describe("coordinatorsOf", () => {
  const worker = (assignments: unknown[]) => session("worker", { assignments: assignments as never });

  test("who handed this conversation work, outstanding first and the rest newest-first", () => {
    const self = worker([
      assignment("old", { outcome: "completed", endedAt: NOW - 100 * MINUTE }),
      assignment("recent", { outcome: "failed", endedAt: NOW - 2 * MINUTE }),
      assignment("live", { scope: "the migration" }),
    ]);
    expect(coordinatorsOf([self], self).map((entry) => [entry.sessionId, entry.outstanding])).toEqual([
      ["live", true],
      ["recent", false],
      ["old", false],
    ]);
  });

  test("the coordinator's row is attached when the list still holds it", () => {
    const coordinator = session("coord", { title: "The coordinator" });
    const self = worker([assignment("coord", { scope: "engine only" })]);
    expect(coordinatorsOf([coordinator, self], self)[0]).toMatchObject({
      session: coordinator,
      scope: "engine only",
      outstanding: true,
    });
  });

  test("an ARCHIVED coordinator is still named — absent from the list is not absent from the record", () => {
    const self = worker([assignment("gone")]);
    const [entry] = coordinatorsOf([self], self);
    expect(entry?.session).toBeUndefined();
    expect(entry?.sessionId).toBe("gone");
  });

  test("`unresolved` is UNKNOWN, never outstanding — its carrier is gone", () => {
    const self = worker([assignment("coord", { unresolved: true })]);
    expect(coordinatorsOf([self], self)[0]).toMatchObject({ outstanding: false, unresolved: true });
  });

  test("a detached errand is not listed: the reader said it is nobody's work", () => {
    const self = worker([assignment("coord", { outcome: "detached", endedAt: NOW })]);
    expect(coordinatorsOf([self], self)).toEqual([]);
  });

  test("a conversation nobody handed work to has no second section at all", () => {
    expect(coordinatorsOf([], session("alone"))).toEqual([]);
  });
});

describe("the sections, rendered", () => {
  test("a delegate row states the scope, the state and a link into the conversation", () => {
    const rows = [session("worker", { title: "Plugin host migration", assignments: [assignment("coord", { scope: "apps/engine only" })] })];
    const html = view({ delegates: delegatesOf(rows, { id: "coord" }) });
    expect(html).toContain("Working for this conversation");
    expect(html).toContain("Plugin host migration");
    expect(html).toContain("apps/engine only");
    expect(html).toContain("1m ago");
    expect(html).toContain('href="/projects/p1/sessions/worker"');
  });

  test("a finished row says HOW IT WENT rather than what the session is doing now", () => {
    // "Idle" on a delegate whose result is waiting to be read would describe
    // the conversation while the reader is asking about the errand.
    const done = [session("a", { assignments: [assignment("coord", { outcome: "completed", endedAt: NOW - MINUTE })] })];
    const failed = [session("b", { assignments: [assignment("coord", { outcome: "failed", endedAt: NOW - MINUTE })] })];
    expect(view({ delegates: delegatesOf(done, { id: "coord" }) })).toContain("Done");
    expect(view({ delegates: delegatesOf(failed, { id: "coord" }) })).toContain("Failed");
  });

  test("a LIVE delegate reports its own activity, in the rail's own words", () => {
    const rows = [session("worker", { activity: "blocked", assignments: [assignment("coord")] })];
    // `activityBadge`'s word, which is about the person rather than the turn.
    expect(view({ delegates: delegatesOf(rows, { id: "coord" }) })).toContain("Waiting on you");
  });

  test("the control offers Follow on a delegate and Stop following on a watched one", () => {
    const rows = [session("worker", { title: "Worker", assignments: [assignment("coord")] })];
    const plain = view({ delegates: delegatesOf(rows, { id: "coord" }), onToggleFollow: () => {} });
    expect(plain).toContain("Follow Worker");
    expect(plain).not.toContain("Stop following Worker");

    const watched = view({
      delegates: delegatesOf(rows, { id: "coord" }, [subscription("sub_1", "worker"), subscription("sub_2", "worker")]),
      onToggleFollow: () => {},
    });
    expect(watched).toContain("Stop following Worker");
    // Deduplicated: one row, one control, both subscriptions behind it.
    expect(watched.split("Stop following Worker").length - 1).toBe(1);
  });

  test("no handler means no control at all", () => {
    const rows = [session("worker", { title: "Worker", assignments: [assignment("coord")] })];
    expect(view({ delegates: delegatesOf(rows, { id: "coord" }) })).not.toContain("Follow Worker");
  });

  test('the inverse is its own section, and an archived coordinator is named without a link', () => {
    const self = session("worker", { assignments: [assignment("gone", { scope: "the parser" })] });
    const html = view({ employers: coordinatorsOf([self], self) });
    expect(html).toContain("Working for");
    expect(html).toContain("the parser");
    expect(html).toContain("no longer listed");
    expect(html).not.toContain('href="/projects/p1/sessions/gone"');
  });

  test("nothing is claimed before the first read lands", () => {
    expect(view({ read: "reading" })).toBe("");
    expect(view({ read: "done" })).toContain("No other conversation is involved");
    expect(view({ read: "failed" })).toContain("The engine did not answer");
  });
});
