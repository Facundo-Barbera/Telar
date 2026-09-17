/**
 * THE RAIL'S AGENT ENTRY — when it exists, and which Mac it opens (#531).
 *
 * THREE CLAIMS, AND THE FIRST IS THE FEATURE BEING OPTIONAL: a cockpit whose
 * engine has never been switched on, or is older than the field, or has not
 * answered yet, draws the rail Telar always drew. There is no "experimental"
 * without that, and it is exactly the kind of thing a later refactor breaks by
 * treating an absent flag as a falsy object.
 *
 * THE SECOND IS THAT IT FOLLOWS THE VIEWED MAC, which is what separates this
 * row from the Main entry it replaces. Main's was the local cockpit's
 * coordinator and only ever that; each Mac has its own Agent, and walking into
 * `/hosts/<id>/…` must swap both whether the row is there and what it opens.
 * A cockpit that drew its OWN answer over somebody else's machine would be the
 * right shape of screen on the wrong Mac, with nothing on it saying so.
 *
 * THE THIRD IS THAT NOTHING ABOUT THE SESSION LIST CAN TAKE IT AWAY. The Agent
 * is not a session, so unlike the Main row there is no id to find among the
 * rows and no way for a full page of conversations to hide the entry.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentRequest, AgentState } from "@telar/engine-client";
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
import { agentStatus } from "@/lib/agent/status";
import { AGENT_JUMP_SLOT } from "@/lib/session-groups";
import { AgentEntry, agentBadgeLabel, agentEntryActive, agentEntryShown, agentHref } from "./agent-entry";

const enabled = (...hosts: string[]) => new Map(hosts.map((host) => [host, true]));

const idle: AgentState = { enabled: true, running: false, queued: 0 };
const request: AgentRequest = {
  type: "approval",
  id: "req_one",
  runId: "run_one",
  tool: "sessions_send",
  args: {},
  toolCallId: "call_one",
  reason: "It wants to assign work to another session.",
  openedAt: 1,
};

describe("whether the rail draws the row", () => {
  test("not at all until an engine says otherwise", () => {
    // Nothing has answered — a first read that has not landed, or an engine
    // older than the field. Both draw the rail Telar always drew.
    expect(agentEntryShown(new Map(), LOCAL_HOST_ID)).toBe(false);
    // Switched off — the ordinary case, and every install's case out of the box.
    expect(agentEntryShown(new Map([[LOCAL_HOST_ID, false]]), LOCAL_HOST_ID)).toBe(false);
  });

  test("only for the Mac being viewed", () => {
    const hosts = enabled(LOCAL_HOST_ID);
    expect(agentEntryShown(hosts, LOCAL_HOST_ID)).toBe(true);
    // THIS COCKPIT'S AGENT IS NOT THAT MAC'S. Looking at a paired Mac that has
    // not switched one on draws no row, rather than a link into an empty screen
    // belonging to a machine that has no Agent.
    expect(agentEntryShown(hosts, "host_other")).toBe(false);
  });

  test("a paired Mac's Agent shows while you are looking at it, and not before", () => {
    const hosts = enabled("host_other");
    expect(agentEntryShown(hosts, "host_other")).toBe(true);
    // The local Mac has not switched one on, so sitting here there is no row —
    // even though a Mac in the book has one.
    expect(agentEntryShown(hosts, LOCAL_HOST_ID)).toBe(false);
  });

  test("a Mac that is away is absent rather than off", () => {
    // The distinction matters for what the rail does NEXT: an away Mac keeps
    // its dimmed rows under a retry line, and a row that read `false` for it
    // would blink off and back on across one failed poll.
    const hosts = new Map([[LOCAL_HOST_ID, true]]);
    expect(hosts.has("host_away")).toBe(false);
    expect(agentEntryShown(hosts, "host_away")).toBe(false);
  });
});

describe("where it goes", () => {
  test("the reserved address, bare for this Mac", () => {
    expect(agentHref()).toBe("/agent");
    expect(agentHref(LOCAL_HOST_ID)).toBe("/agent");
  });

  test("qualified by the Mac for a paired one", () => {
    expect(agentHref("host_other")).toBe("/hosts/host_other/agent");
    // An id that needs escaping must not compose a broken path.
    expect(agentHref("a b")).toBe("/hosts/a%20b/agent");
  });
});

describe("whether the row is the page you are on", () => {
  test("the viewed Mac's own address, and not another's", () => {
    expect(agentEntryActive("/agent", LOCAL_HOST_ID)).toBe(true);
    expect(agentEntryActive("/hosts/host_other/agent", "host_other")).toBe(true);
    // Sitting on a paired Mac's Agent does not light the local row, and would
    // not if both were ever drawn at once.
    expect(agentEntryActive("/hosts/host_other/agent", LOCAL_HOST_ID)).toBe(false);
    expect(agentEntryActive("/projects/p/sessions/s", LOCAL_HOST_ID)).toBe(false);
  });

  test("a sub-route of the screen still counts as being on it", () => {
    // Nothing takes a suffix today. A prefix is right for both now and then,
    // where equality would quietly stop being right the first time one does.
    expect(agentEntryActive("/agent/anything", LOCAL_HOST_ID)).toBe(true);
    // And a sibling that merely starts with the same letters does not.
    expect(agentEntryActive("/agents", LOCAL_HOST_ID)).toBe(false);
  });
});

describe("the entry itself", () => {
  test("a fixed word at a fixed address — nothing read off a session", () => {
    const markup = renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} />);
    expect(markup).toContain('href="/agent"');
    expect(markup).toContain("Agent");
    // No id, and nothing composed with an absent value: the row takes no
    // session, which is the whole reason it cannot be broken by the list.
    expect(markup).not.toContain("undefined");
  });

  /**
   * #539 — THE ROW IS BIGGER, AND IT SAYS SOMETHING.
   *
   * It shipped no taller than a conversation, on the argument that it answers
   * only "where do I go to coordinate". The owner's first night says half of
   * that was wrong: "is it working, is it waiting for me" is a question this
   * row has, and answering nothing made the one always-present entry the least
   * informative thing in the rail.
   */
  test("a card-like row: the taller padding, the larger glyph, the label at text-sm", () => {
    const markup = renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} status={agentStatus(idle)} />);
    expect(markup).toContain("py-2.5");
    expect(markup).toContain("size-4");
    expect(markup).toContain("text-sm");
    // The old row's own measurements are gone rather than sitting beside the new
    // ones — `py-1` and a `size-3` label glyph were the "never taller than a
    // conversation" rule this replaces.
    expect(markup).not.toContain("py-1 ");
  });

  test("the status line reads the four things the row can say", () => {
    const line = (state: Parameters<typeof agentStatus>[0]) =>
      renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} status={agentStatus(state)} />);

    expect(line(idle)).toContain("idle");
    expect(line({ ...idle, running: true })).toContain("working");
    expect(line({ ...idle, queued: 2 })).toContain("2 queued");
    expect(line({ ...idle, lastUsage: { runId: "run_a", at: 1, usage: { input: 2_600, output: 90, total: 2_690 }, contextChars: 10, budgetChars: 100 } })).toContain(
      "2,690 tokens last turn",
    );
  });

  test("the rail's own grammar: a spinner for moving, a still dot for parked", () => {
    const working = renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} status={agentStatus({ ...idle, running: true })} />);
    expect(working).toContain("animate-spin");
    expect(working).toContain("text-primary");

    const waiting = renderToStaticMarkup(
      <AgentEntry active={false} onNavigate={() => {}} status={agentStatus({ ...idle, request })} />,
    );
    // A request that has parked is exactly the thing that is NOT moving.
    expect(waiting).not.toContain("animate-spin");
    expect(waiting).toContain("waiting for you");
    // `--warning` by the vocabulary's own rule: a person has to move.
    expect(waiting).toContain("text-warning");
  });

  test("an idle row is quiet — no mark at all beside its line", () => {
    const markup = renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} status={agentStatus(idle)} />);
    expect(markup).not.toContain("animate-spin");
    expect(markup).toContain("text-sidebar-foreground/45");
  });

  test("a paired Mac's row opens that Mac", () => {
    const markup = renderToStaticMarkup(<AgentEntry hostId="host_other" active={false} onNavigate={() => {}} />);
    expect(markup).toContain('href="/hosts/host_other/agent"');
  });

  test("the open screen is marked as the current page", () => {
    expect(renderToStaticMarkup(<AgentEntry active onNavigate={() => {}} />)).toContain('aria-current="page"');
    expect(renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} />)).not.toContain("aria-current");
  });

  /**
   * #569 — THE ROW HOLDS ⌘1, so it has to wear it.
   *
   * The row's slot is not a variable: it is drawn above every band, so if it is
   * drawn at all it is the first entry in the rail. What is asserted here is
   * that the number is that one and no other, and that putting the caps over the
   * badge's slot did not cost the badge — the caps only appear while ⌘ is held,
   * and the count has to be legible the rest of the time.
   */
  test("its number is the first, and the unread badge still draws under it", () => {
    expect(AGENT_JUMP_SLOT).toBe(1);
    const markup = renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} status={agentStatus(idle)} unread={3} />);
    expect(markup).toContain('aria-label="3 unread"');
    // Nothing is drawn for the chord itself until a modifier is held — see
    // `KeyHintOverlay`, whose own behaviour is pinned in ui/key-hint.test.tsx.
    expect(markup).not.toContain("kbd");
  });
});

/**
 * THE WAKE BADGE — issue #541, section A.
 *
 * A wake no longer starts an Agent turn, so this row is where a person learns
 * anything arrived at all without opening the screen. The count comes off the
 * SAME state the status line does, so it costs no second poll.
 */
describe("the unread badge", () => {
  test("absent and zero both draw nothing, and they are different facts", () => {
    // ABSENT is a Mac whose engine is older than the field; ZERO is one saying
    // the inbox is empty. Neither draws a badge, so a cockpit pointed at an old
    // Mac shows the row it always did.
    expect(agentBadgeLabel(undefined)).toBeUndefined();
    expect(agentBadgeLabel(0)).toBeUndefined();
    expect(renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} status={agentStatus(idle)} />)).not.toContain("unread");
  });

  test("a count is drawn, and a large one is clamped to a label", () => {
    expect(agentBadgeLabel(1)).toBe("1");
    expect(agentBadgeLabel(99)).toBe("99");
    // The row has a fixed width, and 143 versus 208 waiting updates is not a
    // difference anybody acts on.
    expect(agentBadgeLabel(100)).toBe("99+");
    const markup = renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} status={agentStatus(idle)} unread={4} />);
    expect(markup).toContain('aria-label="4 unread"');
    expect(markup).toContain(">4<");
  });

  test("the badge carries no urgency tone — that is the status line's job", () => {
    // Two things competing to signal urgency on one row is how neither gets
    // read: the count says something arrived, the line under it says whether
    // somebody has to move.
    const markup = renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} status={agentStatus(idle)} unread={9} />);
    expect(markup).not.toContain("text-warning");
    const waiting = renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} status={agentStatus({ ...idle, request })} unread={9} />);
    expect(waiting).toContain("text-warning");
    expect(waiting).toContain('aria-label="9 unread"');
  });
});
