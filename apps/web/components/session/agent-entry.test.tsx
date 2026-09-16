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
import { LOCAL_HOST_ID } from "@/lib/hosts/book";
import { AgentEntry, agentEntryActive, agentEntryShown, agentHref } from "./agent-entry";

const enabled = (...hosts: string[]) => new Map(hosts.map((host) => [host, true]));

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

  test("a paired Mac's row opens that Mac", () => {
    const markup = renderToStaticMarkup(<AgentEntry hostId="host_other" active={false} onNavigate={() => {}} />);
    expect(markup).toContain('href="/hosts/host_other/agent"');
  });

  test("the open screen is marked as the current page", () => {
    expect(renderToStaticMarkup(<AgentEntry active onNavigate={() => {}} />)).toContain('aria-current="page"');
    expect(renderToStaticMarkup(<AgentEntry active={false} onNavigate={() => {}} />)).not.toContain("aria-current");
  });
});
