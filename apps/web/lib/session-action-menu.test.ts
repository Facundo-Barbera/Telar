/**
 * The point of a single definition is that it is checkable in one place. These
 * tests are what make that true: ordering, the three toggles, every capability
 * gate and the one destructive flag, asserted on the ARRAY rather than through
 * a rendered menu. A React test would prove that a dropdown draws its items and
 * nothing about whether the two surfaces agree — which is the only thing this
 * module exists to guarantee.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  buildSessionActionMenuItems,
  type SessionActionHandlers,
  type SessionActionItem,
  type SessionActionMenuState,
  type SessionActionTarget,
} from "./session-action-menu";

/** Fixed so the snooze presets resolve to the same five rows every run: a
 *  Wednesday at 10:00 local, which is early enough that "This evening" is still
 *  more than an hour away and therefore present. */
const NOW = new Date(2026, 8, 9, 10, 0, 0).getTime();

const target = (over: Partial<SessionActionTarget> = {}): SessionActionTarget => ({
  id: "session_1",
  title: "A session",
  projectId: "project_1",
  projectName: "Telar",
  workspacePath: "/Users/someone/code/telar",
  archived: false,
  updatedAt: NOW - 60_000,
  ...over,
});

/** Every handler, each recording what it was called with. `shell: true` adds
 *  the one only the desktop supplies — which is what the web build gates the
 *  new-window item on by simply not having it. */
function spies(over: { shell?: boolean } = {}) {
  const calls: Array<[string, unknown]> = [];
  const record =
    (name: string) =>
    (input?: unknown): void => {
      calls.push([name, input]);
    };
  const handlers: SessionActionHandlers = {
    open: record("open"),
    copyLink: record("copyLink"),
    ...(over.shell ? { openWindow: record("openWindow") } : {}),
    newSession: record("newSession"),
    pin: record("pin"),
    settle: record("settle"),
    snooze: record("snooze"),
    rename: record("rename"),
    copy: record("copy"),
    projectSettings: record("projectSettings"),
    remove: record("remove"),
  };
  return { calls, handlers };
}

function build(over: Partial<Omit<SessionActionMenuState, "actions">> = {}, handlers?: SessionActionHandlers) {
  return buildSessionActionMenuItems({
    session: target(),
    activity: {},
    now: NOW,
    ...over,
    actions: handlers ?? spies().handlers,
  });
}

const ids = (items: readonly SessionActionItem[]) => items.map((item) => item.id);
const byId = (items: readonly SessionActionItem[], id: string) => items.find((item) => item.id === id)!;

describe("ordering", () => {
  test("six groups, in the order the survey names them", () => {
    expect(ids(build())).toEqual([
      "open",
      "new-session",
      "pin",
      "settle",
      "snooze",
      "rename",
      "copy",
      "project-settings",
      "delete",
    ]);
  });

  test("the shell's window row sits beside Open, in the same group", () => {
    expect(ids(build({}, spies({ shell: true }).handlers))).toEqual([
      "open",
      "open-window",
      "new-session",
      "pin",
      "settle",
      "snooze",
      "rename",
      "copy",
      "project-settings",
      "delete",
    ]);
  });

  test("a separator opens each group after the first, and nowhere else", () => {
    const separated = build()
      .filter((item) => item.separatorBefore)
      .map((item) => item.id);
    expect(separated).toEqual(["new-session", "pin", "rename", "copy", "delete"]);
  });

  test("the archived session drops the whole inbox group rather than showing three inert rows", () => {
    expect(ids(build({ session: target({ archived: true }) }))).toEqual([
      "open",
      "new-session",
      "rename",
      "copy",
      "project-settings",
      "delete",
    ]);
  });

  test("dropping the group moves the separator onto what now opens it", () => {
    // Rename carries `separatorBefore` in both arrangements, so the archived
    // menu does not open with a hairline against nothing above it.
    expect(byId(build({ session: target({ archived: true }) }), "rename").separatorBefore).toBe(true);
  });
});

describe("getting to it: one href, three items", () => {
  test("Open sends the route the row's own click would — sessionHref's answer, not a second spelling", () => {
    const { calls, handlers } = spies();
    byId(build({}, handlers), "open").run!();
    expect(calls).toEqual([["open", "/projects/project_1/sessions/session_1"]]);
  });

  test("a session on another Mac carries its host into every one of the three", () => {
    const { calls, handlers } = spies({ shell: true });
    const items = build({ session: target({ hostId: "host_mini" }) }, handlers);
    byId(items, "open").run!();
    byId(items, "open-window").run!();
    byId(byId(items, "copy").children!, "copy-link").run!();
    const href = "/hosts/host_mini/projects/project_1/sessions/session_1";
    expect(calls).toEqual([
      ["open", href],
      ["openWindow", href],
      ["copyLink", href],
    ]);
  });

  test("a project-less session addresses /main, rather than a /projects/undefined link", () => {
    // ONE MAIN CONVERSATION PER MACHINE (#526), so the role has an address even
    // though the session has no project-scoped one. It used to be the front
    // door, which was honest but landed nowhere in particular.
    const { calls, handlers } = spies();
    const items = build({ session: target({ projectId: undefined }) }, handlers);
    byId(items, "open").run!();
    byId(byId(items, "copy").children!, "copy-link").run!();
    expect(calls).toEqual([
      ["open", "/main"],
      ["copyLink", "/main"],
    ]);
  });

  test("Open says why it is inert on the session you are already reading, and stays put", () => {
    const items = build({ capabilities: { current: true } });
    expect(byId(items, "open").disabled).toBe("You are already reading this one.");
    // In the list, and first: the row must not move out from under the pointer
    // between the rail's menu and the header's.
    expect(items[0]!.id).toBe("open");
  });

  test("and does not navigate to where you already are", () => {
    const { calls, handlers } = spies();
    byId(build({ capabilities: { current: true } }, handlers), "open").run!();
    expect(calls).toEqual([]);
  });

  test("a second window on the session you are reading is the ordinary reason to want one", () => {
    const { calls, handlers } = spies({ shell: true });
    const items = build({ capabilities: { current: true } }, handlers);
    expect(byId(items, "open-window").disabled).toBeFalsy();
    byId(items, "open-window").run!();
    expect(calls).toEqual([["openWindow", "/projects/project_1/sessions/session_1"]]);
  });

  test("without the shell's handler the row is ABSENT, not greyed — a browser tab cannot open a window", () => {
    expect(ids(build())).not.toContain("open-window");
    // On every arrangement, so it cannot creep back in through one of them.
    for (const arrangement of [
      build({ session: target({ archived: true }) }),
      build({ capabilities: { remote: true, current: true } }),
    ]) {
      expect(ids(arrangement)).not.toContain("open-window");
    }
  });

  test("and neither is refused on an archived session — its transcript is still worth reading", () => {
    const items = build({ session: target({ archived: true }) }, spies({ shell: true }).handlers);
    expect(byId(items, "open").disabled).toBeFalsy();
    expect(byId(items, "open-window").disabled).toBeFalsy();
  });
});

describe("the second group names where the new session will run", () => {
  test("a worktree session's branch, because that is what it will be cut from", () => {
    const items = build({ session: target({ branch: "telar/some-work" }) });
    expect(byId(items, "new-session").label).toBe("New session on telar/some-work");
  });

  test("a local session names the project instead — it has no branch of its own", () => {
    expect(byId(build(), "new-session").label).toBe("New session in Telar");
  });

  test("and falls back to a phrase rather than an opaque project id", () => {
    const items = build({ session: target({ projectName: undefined }) });
    expect(byId(items, "new-session").label).toBe("New session in this project");
  });

  test("the branch rides along as the base ref, with the host", () => {
    const { calls, handlers } = spies();
    const items = build({ session: target({ branch: "telar/some-work", hostId: "host_mini" }) }, handlers);
    byId(items, "new-session").run!();
    expect(calls).toEqual([["newSession", { projectId: "project_1", hostId: "host_mini", baseRef: "telar/some-work" }]]);
  });

  test("a local session sends no base ref and no host", () => {
    const { calls, handlers } = spies();
    byId(build({}, handlers), "new-session").run!();
    expect(calls).toEqual([["newSession", { projectId: "project_1" }]]);
  });
});

describe("toggles swap in place", () => {
  test("pin is one row that knows which way it points", () => {
    const loose = byId(build(), "pin");
    const pinned = byId(build({ session: target({ settledOverride: "active" }) }), "pin");
    expect(loose.label).toBe("Pin to the list");
    expect(pinned.label).toBe("Unpin");
    // Same id through the swap, so a surface's key and a test can follow it.
    expect(loose.id).toBe(pinned.id);
    expect(loose.kind).toBe("toggle");
    expect(pinned.kind).toBe("toggle");
  });

  test("pin sends the direction it is offering, not the one it is in", () => {
    const { calls, handlers } = spies();
    byId(build({}, handlers), "pin").run!();
    byId(build({ session: target({ settledOverride: "active" }) }, handlers), "pin").run!();
    expect(calls).toEqual([
      ["pin", true],
      ["pin", false],
    ]);
  });

  test("a drift-settled session reads Un-settle too, though it holds no override", () => {
    // The rail's `bandOf` and the cockpit's `settled` both fold the clock; the
    // menu takes their answer rather than re-deriving one it cannot.
    const items = build({ session: target({ settled: true }) });
    expect(byId(items, "settle").label).toBe("Un-settle");
    expect(byId(items, "pin").label).toBe("Pin to the list");
  });

  test("settle swaps to un-settle, and sends the opposite of where it is", () => {
    const { calls, handlers } = spies();
    const settled = byId(build({ session: target({ settledOverride: "settled" }) }, handlers), "settle");
    expect(settled.label).toBe("Un-settle");
    expect(byId(build({}, handlers), "settle").label).toBe("Settle");
    settled.run!();
    expect(calls).toEqual([["settle", false]]);
  });

  test("snooze becomes Wake now on a sleeping session, with the countdown beside it", () => {
    const items = build({ session: target({ snoozedUntil: NOW + 3 * 60 * 60 * 1000, snoozedAt: NOW - 1000 }) });
    const snooze = byId(items, "snooze");
    expect(snooze.label).toBe("Wake now");
    expect(snooze.detail).toBe("3h");
    expect(snooze.children).toBeUndefined();
    expect(snooze.kind).toBe("toggle");
  });

  test("wake now clears the snooze rather than setting a time", () => {
    const { calls, handlers } = spies();
    const items = build({ session: target({ snoozedUntil: NOW + 60_000, snoozedAt: NOW - 1000 }) }, handlers);
    byId(items, "snooze").run!();
    expect(calls).toEqual([["snooze", null]]);
  });

  test("an awake session offers the presets as children, each with its resolved time", () => {
    const snooze = byId(build(), "snooze");
    expect(snooze.label).toBe("Snooze");
    expect(snooze.run).toBeUndefined();
    expect(snooze.children!.map((child) => child.id)).toEqual([
      "snooze-hour",
      "snooze-three-hours",
      "snooze-evening",
      "snooze-tomorrow",
      "snooze-next-week",
    ]);
    // The time column complements the label rather than repeating it.
    expect(snooze.children!.every((child) => typeof child.detail === "string" && child.detail.length > 0)).toBe(true);
  });

  test("a preset sends its own resolved instant", () => {
    const { calls, handlers } = spies();
    byId(build({}, handlers), "snooze").children![0]!.run!();
    expect(calls).toEqual([["snooze", NOW + 60 * 60 * 1000]]);
  });

  test("a snooze the session has woken early from is not a Wake now row", () => {
    // `raisedHandWhileSnoozed`: a request parked on a human outranks the snooze,
    // so the session is not snoozed and the row offers presets again.
    const items = build({
      session: target({ snoozedUntil: NOW + 60_000, snoozedAt: NOW - 1000 }),
      activity: { waitingOnYou: true },
    });
    expect(byId(items, "snooze").label).toBe("Snooze");
  });
});

describe("gating: disabled with a reason beats failing later", () => {
  test("nothing is disabled on an ordinary idle session", () => {
    expect(build().filter((item) => item.disabled)).toEqual([]);
  });

  test("delete is refused while a turn is running — the engine would reject it", () => {
    const item = byId(build({ activity: { working: true } }), "delete");
    expect(item.disabled).toBe("A turn is running. Stop it before deleting.");
  });

  test("and refused on a blocked session, whose turn is equally in flight", () => {
    const item = byId(build({ activity: { waitingOnYou: true } }), "delete");
    expect(item.disabled).toBe("A request here is waiting on you. Answer or stop it first.");
  });

  test("settling is refused for the reason that applies, not a generic one", () => {
    expect(byId(build({ activity: { waitingOnYou: true } }), "settle").disabled).toBe("Something here is waiting on you.");
    expect(byId(build({ activity: { working: true } }), "settle").disabled).toBe("A turn is running here.");
  });

  test("un-settling is never refused: the rule is about shelving, not returning", () => {
    const items = build({ session: target({ settledOverride: "settled" }), activity: { working: true } });
    expect(byId(items, "settle").label).toBe("Un-settle");
    expect(byId(items, "settle").disabled).toBe(false);
  });

  test("a running session may still be snoozed — snoozing only changes what you are shown", () => {
    expect(byId(build({ activity: { working: true } }), "snooze").disabled).toBe(false);
  });

  test("a session waiting on you may not: hiding the question defeats it", () => {
    const snooze = byId(build({ activity: { waitingOnYou: true } }), "snooze");
    expect(snooze.disabled).toBe("Something here is waiting on you.");
    // The refusal sits on the parent, so the submenu is never opened to learn it.
    expect(snooze.children!.every((child) => !child.disabled)).toBe(true);
  });

  test("rename is refused on an archived session", () => {
    expect(byId(build({ session: target({ archived: true }) }), "rename").disabled).toBe("This conversation is over.");
  });

  test("a session with no project cannot start a sibling or open settings", () => {
    const items = build({ session: target({ projectId: undefined }) });
    expect(byId(items, "new-session").disabled).toBe("This session belongs to no project.");
    expect(byId(items, "project-settings").disabled).toBe("This session belongs to no project.");
    // It can still be opened: the front door is a real address.
    expect(byId(items, "open").disabled).toBeFalsy();
  });

  test("a disabled item's run is inert rather than building a broken URL", () => {
    const { calls, handlers } = spies();
    const items = build({ session: target({ projectId: undefined }) }, handlers);
    byId(items, "new-session").run!();
    byId(items, "project-settings").run!();
    expect(calls).toEqual([]);
  });

  test("project settings are local-only, because there is no per-host route", () => {
    const items = build({ session: target({ hostId: "host_mini" }), capabilities: { remote: true } });
    expect(byId(items, "project-settings").disabled).toBe("Project settings open on the Mac that owns the project.");
    // The rest of the menu still works on another Mac's session.
    expect(byId(items, "new-session").disabled).toBeFalsy();
    expect(byId(items, "delete").disabled).toBeFalsy();
  });
});

describe("copy", () => {
  test("link, path and id always; branch only when the session has one of its own", () => {
    expect(byId(build(), "copy").children!.map((child) => child.id)).toEqual(["copy-link", "copy-path", "copy-id"]);
    expect(byId(build({ session: target({ branch: "telar/x" }) }), "copy").children!.map((child) => child.id)).toEqual([
      "copy-link",
      "copy-path",
      "copy-branch",
      "copy-id",
    ]);
  });

  test("each child copies the fact it names", () => {
    const { calls, handlers } = spies();
    const children = byId(build({ session: target({ branch: "telar/x" }) }, handlers), "copy").children!;
    for (const child of children) child.run!();
    expect(calls).toEqual([
      // The link is its own handler: a path is not a link until a surface with
      // an origin resolves it, and this module has none.
      ["copyLink", "/projects/project_1/sessions/session_1"],
      ["copy", "/Users/someone/code/telar"],
      ["copy", "telar/x"],
      ["copy", "session_1"],
    ]);
  });
});

describe("the destructive flag", () => {
  test("delete is the only one, and it is last", () => {
    const items = build();
    expect(items.filter((item) => item.destructive).map((item) => item.id)).toEqual(["delete"]);
    expect(items.at(-1)!.id).toBe("delete");
  });

  test("it stays the only one on every arrangement of the menu", () => {
    const arrangements = [
      build({ session: target({ archived: true }) }),
      build({ session: target({ snoozedUntil: NOW + 60_000, snoozedAt: NOW - 1 }) }),
      build({ session: target({ settledOverride: "settled", branch: "telar/x" }) }),
      build({ capabilities: { remote: true } }),
    ];
    for (const items of arrangements) {
      expect(items.filter((item) => item.destructive).map((item) => item.id)).toEqual(["delete"]);
    }
  });
});

describe("what is deliberately not here", () => {
  test("no archive and no mark-unread, on any arrangement", () => {
    // Both were removed on purpose — see the header of session-inbox-menu.tsx
    // and the survey's "Do not adopt". This is the guard against them coming
    // back through the one file both surfaces now read.
    const everything = [
      ...build(),
      ...build({ session: target({ archived: true }) }),
      ...build({ session: target({ settledOverride: "settled" }) }),
    ];
    const labels = everything.map((item) => item.label.toLowerCase());
    expect(labels.some((label) => label.includes("archive"))).toBe(false);
    expect(labels.some((label) => label.includes("unread"))).toBe(false);
  });

  test("no regenerate-title: the engine exposes no route to ask for one", () => {
    expect(ids(build())).not.toContain("regenerate-title");
  });
});

describe("purity", () => {
  test("same state in, same list out — no clock of its own", () => {
    const first = build();
    const second = build();
    expect(ids(first)).toEqual(ids(second));
    expect(byId(first, "snooze").children!.map((child) => child.detail)).toEqual(
      byId(second, "snooze").children!.map((child) => child.detail),
    );
  });

  test("building the menu calls no handler", () => {
    const { calls, handlers } = spies();
    build({}, handlers);
    build({ session: target({ archived: true }) }, handlers);
    expect(calls).toEqual([]);
  });
});
