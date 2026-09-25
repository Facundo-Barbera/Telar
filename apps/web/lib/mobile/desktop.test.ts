// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  DESKTOP_APPROVE, DESKTOP_APPROVED, DESKTOP_NOTICE, DESKTOP_NOTIFICATIONS_ENV,
  desktopAttached, desktopNotices, emptyDesktopState, handleDesktopMessage, type DesktopState,
} from "./desktop";
import { notification, type MobileRegistration, type SessionSignal } from "./push";

const working: SessionSignal = { id: "s1", title: "Private repository task", activity: "working", activityAt: 1000, projectId: "p1" };
const blocked: SessionSignal = { ...working, activity: "blocked", activityAt: 2000 };
const finished: SessionSignal = { ...working, activity: "idle", activityAt: 3000, lastTurnEndedAt: 3000 };
const failed: SessionSignal = { ...finished, lastTurnFailed: true };

function pass(state: DesktopState, sessions: SessionSignal[], changed?: Set<string>) {
  return desktopNotices(state, sessions, changed);
}

describe("which transitions reach the Mac", () => {
  test("the first pass baselines: a launch never replays history", () => {
    const { notices, state } = pass(emptyDesktopState(), [blocked, failed]);
    expect(notices).toEqual([]);
    expect(state.baselined).toBe(true);
  });

  test("blocked, finished and failed each fire once per transition", () => {
    let { state } = pass(emptyDesktopState(), [working]);
    const toBlocked = pass(state, [blocked]);
    expect(toBlocked.notices.map((n) => n.kind)).toEqual(["blocked"]);
    expect(pass(toBlocked.state, [blocked]).notices).toEqual([]);
    ({ state } = pass(toBlocked.state, [working]));
    expect(pass(state, [finished]).notices.map((n) => n.kind)).toEqual(["finished"]);
    expect(pass(state, [failed]).notices.map((n) => n.kind)).toEqual(["failed"]);
  });

  test("a session created after the baseline alerts on first sight", () => {
    const { state } = pass(emptyDesktopState(), []);
    expect(pass(state, [blocked]).notices).toHaveLength(1);
  });

  test("an unchanged session outside the change set is skipped, as a phone record skips it", () => {
    const { state } = pass(emptyDesktopState(), [working]);
    const moved = { ...blocked, id: "s2" };
    const next = pass({ ...state, seen: { ...state.seen, s2: "stale" } }, [blocked, moved], new Set(["s2"]));
    expect(next.notices.map((n) => n.sessionId)).toEqual(["s2"]);
  });

  test("agrees with the phone's rule, including the completions gate and the ungated failure", () => {
    const phone: MobileRegistration = { hostId: "h", token: "t", topic: "com.telar.mobile", sandbox: false, enabled: true, completions: false, previews: true, mutedSessions: [], activities: [] };
    const { state } = pass(emptyDesktopState(), [working]);
    const prefs = { completions: false, previews: true };
    expect(desktopNotices(state, [finished], undefined, prefs).notices).toEqual([]);
    expect(notification(phone, finished, state.seen.s1)).toBeUndefined();
    expect(desktopNotices(state, [failed], undefined, prefs).notices).toHaveLength(1);
  });

  test("the title is the session's by default on the Mac, generic when previews are off", () => {
    const { state } = pass(emptyDesktopState(), [working]);
    const [shown] = pass(state, [blocked]).notices;
    expect(shown).toMatchObject({ type: DESKTOP_NOTICE, title: "Private repository task", path: "/projects/p1/sessions/s1" });
    const [hidden] = desktopNotices(state, [blocked], undefined, { completions: true, previews: false }).notices;
    expect(hidden.title).toBe("Telar");
    expect(JSON.stringify(hidden)).not.toContain("Private");
  });

  test("a session with no project opens at /main", () => {
    const { state } = pass(emptyDesktopState(), [{ ...working, projectId: undefined }]);
    expect(pass(state, [{ ...blocked, projectId: undefined }]).notices[0].path).toBe("/main");
  });

  test("Approve is offered only for a single approvable request, and the offer retires when the session moves", () => {
    const { state } = pass(emptyDesktopState(), [working]);
    expect(pass(state, [blocked]).notices[0].request).toBeUndefined();
    const offered = pass(state, [{ ...blocked, approvable: "r1" }]);
    expect(offered.notices[0].request).toBe("r1");
    expect(offered.state.offered).toEqual({ s1: "r1" });
    expect(pass(offered.state, [working]).state.offered).toEqual({});
    expect(pass(offered.state, []).state.offered).toEqual({});
  });
});

describe("the fork channel", () => {
  const channel = () => {
    const sent: unknown[] = [];
    return { sent, on: () => undefined, connected: true, send: (message: unknown) => (sent.push(message), true) };
  };

  test("is attached only when the shell forked this process and said so", () => {
    expect(desktopAttached(channel(), { [DESKTOP_NOTIFICATIONS_ENV]: "1" })).toBe(true);
    // `next dev` has a process.send too — to Next's own CLI.
    expect(desktopAttached(channel(), {})).toBe(false);
    expect(desktopAttached({ on: () => undefined }, { [DESKTOP_NOTIFICATIONS_ENV]: "1" })).toBe(false);
    expect(desktopAttached({ ...channel(), connected: false }, { [DESKTOP_NOTIFICATIONS_ENV]: "1" })).toBe(false);
  });

  test("Approve resolves exactly the offered request, with accept, once", async () => {
    const state: DesktopState = { seen: {}, baselined: true, offered: { s1: "r1" } };
    const resolved: unknown[] = [];
    const resolve = async (...args: unknown[]) => { resolved.push(args); };
    const wire = channel();
    await handleDesktopMessage({ type: DESKTOP_APPROVE, sessionId: "s1", requestId: "r1" }, resolve, wire, state);
    expect(resolved).toEqual([["s1", "r1", { decision: "accept" }]]);
    expect(wire.sent).toEqual([{ type: DESKTOP_APPROVED, sessionId: "s1", requestId: "r1", ok: true }]);
    // The same press twice, or a request this process never offered, resolves nothing.
    await handleDesktopMessage({ type: DESKTOP_APPROVE, sessionId: "s1", requestId: "r1" }, resolve, wire, state);
    await handleDesktopMessage({ type: DESKTOP_APPROVE, sessionId: "s1", requestId: "r2" }, resolve, wire, { ...state, offered: { s1: "r1" } });
    expect(resolved).toHaveLength(1);
    expect(wire.sent.slice(1)).toEqual([
      { type: DESKTOP_APPROVED, sessionId: "s1", requestId: "r1", ok: false },
      { type: DESKTOP_APPROVED, sessionId: "s1", requestId: "r2", ok: false },
    ]);
  });

  test("a failed resolve answers not ok, and malformed messages are ignored", async () => {
    const wire = channel();
    await handleDesktopMessage({ type: DESKTOP_APPROVE, sessionId: "s1", requestId: "r1" }, async () => { throw new Error("409"); }, wire, { seen: {}, baselined: true, offered: { s1: "r1" } });
    expect(wire.sent).toEqual([{ type: DESKTOP_APPROVED, sessionId: "s1", requestId: "r1", ok: false }]);
    for (const junk of [null, "approve", { type: "other" }, { type: DESKTOP_APPROVE, sessionId: 1, requestId: "r1" }, { type: DESKTOP_APPROVE, sessionId: "s1", requestId: "" }]) {
      await handleDesktopMessage(junk, async () => { throw new Error("must not run"); }, wire, { seen: {}, baselined: true, offered: { s1: "r1" } });
    }
    expect(wire.sent).toHaveLength(1);
  });
});
