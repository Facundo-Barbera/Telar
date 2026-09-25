/**
 * APPROVE FROM THE NOTIFICATION — which alerts may offer it, and what it names.
 *
 * What must not drift:
 *
 *   - Approve is offered only for exactly one open approval (command, edit,
 *     read, tool call); a question or a secret keeps Open only;
 *   - the alert names THAT request, so the phone resolves it and nothing newer;
 *   - every alert carries a category, so every one gets Open;
 *   - only sessions whose signal moved are read, and a failed read still alerts.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { CATEGORY_REQUEST, CATEGORY_SESSION, notification, type MobileRegistration, type SessionSignal } from "./push";
import { markApprovable } from "./worker";

const record: MobileRegistration = {
  hostId: "12345678-1234-1234-1234-123456789abc", token: "a".repeat(64), topic: "com.telar.mobile", sandbox: false,
  enabled: true, completions: true, previews: false, mutedSessions: [], activities: [],
};
const blocked = (patch: Partial<SessionSignal> = {}): SessionSignal => ({ id: "session_1", title: "Deploy", activity: "blocked", ...patch });
const request = (id: string, kind: string, state = "open") => ({ id, state, detail: { kind } });

describe("which blocked sessions can be approved from the alert", () => {
  test("exactly one open approval, of a kind that is an approval", async () => {
    for (const kind of ["command_execution", "file_change", "file_read", "tool_call"]) {
      const sessions = [blocked()];
      await markApprovable(sessions, undefined, async () => ({ requests: [request("req_1", kind), request("req_0", kind, "resolved")] }));
      expect(sessions[0].approvable).toBe("req_1");
    }
  });

  test("a question, a secret, or two open requests keep Open only", async () => {
    for (const requests of [[request("q", "user_input")], [request("s", "secret_access")], [request("a", "tool_call"), request("b", "tool_call")]]) {
      const sessions = [blocked()];
      await markApprovable(sessions, undefined, async () => ({ requests }));
      expect(sessions[0].approvable).toBeUndefined();
    }
  });

  test("only sessions that moved are read, and a failed read still lets the alert go", async () => {
    const read: string[] = [];
    const sessions = [blocked({ id: "moved" }), blocked({ id: "still" }), { id: "working", title: "x", activity: "working" }];
    await markApprovable(sessions, new Set(["moved", "working"]), async id => { read.push(id); throw new Error("engine down"); });
    expect(read).toEqual(["moved"]);
    expect(notification(record, sessions[0], "working:0:0:false")).toBeDefined();
  });
});

describe("the alert", () => {
  test("names the one request Approve resolves, under the category that offers it", () => {
    const payload = notification(record, blocked({ approvable: "req_1" }), "working:0:0:false")!.payload;
    expect(payload.aps.category).toBe(CATEGORY_REQUEST);
    expect(payload.request).toBe("req_1");
  });

  test("without one, and for a finished or failed session, it offers Open only", () => {
    const plain = notification(record, blocked(), "working:0:0:false")!.payload;
    expect(plain.aps.category).toBe(CATEGORY_SESSION);
    expect(plain.request).toBeUndefined();
    const failed = notification(record, { id: "s", title: "x", activity: "idle", lastTurnEndedAt: 5, lastTurnFailed: true, approvable: "stale" }, "working:0:0:false")!.payload;
    expect(failed.aps.category).toBe(CATEGORY_SESSION);
    expect(failed.request).toBeUndefined();
  });
});
