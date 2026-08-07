// THE SIDEBAR'S ATTENTION CHAIN (creative-run defects, task #20). Two facts
// the row must tell the truth about, pinned end to end because each lives in
// a different file and only their AGREEMENT is the feature:
//
// 1. LIVENESS IS THE WINDOW, NOT THE RUN. The persistent runtime made
//    "no turn in flight, agents still working" a normal state; a dot derived
//    from isSessionRunLive alone reads idle exactly when the user most needs
//    to know work is happening (the defect this fixes).
// 2. AN OPEN QUESTION OUTRANKS EVERYTHING. "Needs your approval" is the one
//    state whose job is to interrupt — it renders before both live states, in
//    the amber the Marker primitive reserves for attention, and it is derived
//    from the SAME pending registry the cards resolve through, so row and
//    card can never disagree.
//
// The behavioral half (sessionsAwaitingApproval add/remove) lives in
// permissions.test.ts with the rest of the registry's tests.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const WEB_ROOT = new URL("../", import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, WEB_ROOT), "utf8");

describe("the /api/chats derivation", () => {
  const src = read("app/api/chats/route.ts");

  test("live = run OR window, one expression", () => {
    expect(src).toContain("live: isSessionRunLive(c.id) || isSessionWindowLive(c.id)");
  });

  test("needsApproval comes from the pending registry, one pass per response", () => {
    expect(src).toContain("const awaiting = sessionsAwaitingApproval();");
    expect(src).toContain("...(awaiting.has(c.id) ? { needsApproval: true } : {})");
  });
});

describe("the row's precedence: approval > live > background > time", () => {
  const src = read("components/session/session-row.tsx");

  test("every render site branches on needsApproval BEFORE live", () => {
    // Index order in source is the branch order of the ternary chains — the
    // row's dot, the row's meta line, and the hover card's status line each
    // check approval first. Three sites, each followed by its session.live.
    const sites = src.split("session.needsApproval ?");
    expect(sites.length).toBe(4); // three checks
    for (const after of sites.slice(1)) expect(after).toContain("session.live ?");
  });

  test("the state is said in words, in attention amber", () => {
    expect(src.match(/Needs your approval/g)?.length).toBe(2);
    expect(src).toContain("text-amber-600 dark:text-amber-400");
  });
});

describe("the nudge: an event-driven sidebar hears about cards", () => {
  test("card open and card resolved each dispatch a chats refresh", () => {
    // Chats are never polled (app-sidebar reloads only on telar:refresh /
    // telar:session-run) — without these two dispatches the amber state
    // would wait for the next unrelated mutation to appear or clear.
    const src = read("components/session/session-view.tsx");
    const permCase = src.slice(
      src.indexOf('case "permission":'),
      src.indexOf('case "permission_denied"'),
    );
    const dispatches = permCase.match(/dispatchTelarRefresh\(\{ domains: \["chats"\] \}\)/g);
    expect(dispatches?.length).toBe(2);
  });
});
