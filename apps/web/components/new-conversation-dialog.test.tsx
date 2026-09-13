// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { matchTargets, QUICK_PICK_LIMIT, type NewConversationTarget } from "./new-conversation-dialog";

/**
 * THE PALETTE'S RULES, and the two halves they live in.
 *
 * `matchTargets` is the whole of what typing does, so it is exercised directly
 * rather than through a render — the same shape `lib/`-side logic gets
 * everywhere else here. The KEYBOARD cannot be driven by a static render (and
 * the dialog renders through a portal, so there is no markup to assert on
 * either), so the parts that only exist after a keystroke are pinned against
 * source, exactly as settings-search-nav.test.tsx pins its own.
 */
const source = readFileSync(new URL("./new-conversation-dialog.tsx", import.meta.url), "utf8");
const sidebar = readFileSync(new URL("./app-sidebar.tsx", import.meta.url), "utf8");

const targets: NewConversationTarget[] = [
  { id: "project_a", name: "Telar", root: "/Users/someone/code/telar" },
  { id: "project_b", name: "Notes", root: "/Users/someone/code/notes" },
  { id: "project_c", name: "Telar", hostId: "host_mini", hostName: "mini" },
];

test("a blank query is every project, not none", () => {
  expect(matchTargets(targets, "").length).toBe(3);
  expect(matchTargets(targets, "   ").length).toBe(3);
});

test("anything the row shows is something you can type", () => {
  // The row shows name, host and path — so all three match, which is the rule
  // that keeps a reader from typing what they can see and getting nothing.
  expect(matchTargets(targets, "notes").map((t) => t.id)).toEqual(["project_b"]);
  expect(matchTargets(targets, "mini").map((t) => t.id)).toEqual(["project_c"]);
  expect(matchTargets(targets, "code/notes").map((t) => t.id)).toEqual(["project_b"]);
  // Case is not a filter.
  expect(matchTargets(targets, "TELAR").length).toBe(2);
  expect(matchTargets(targets, "nothing like this")).toEqual([]);
});

test("a paired Mac's projects are in the same list, told apart by the host", () => {
  const both = matchTargets(targets, "telar");
  expect(both.map((t) => t.hostName)).toEqual([undefined, "mini"]);
  // Two Macs can register the same project id, so the row's key carries the
  // host — otherwise React reconciles them into one row.
  expect(source).toContain('key={`${target.hostId ?? "local"}:${target.id}`}');
});

test("⌘1..⌘9 take the first nine rows AS FILTERED", () => {
  expect(QUICK_PICK_LIMIT).toBe(9);
  // The number is the row's place in front of the reader, not its place in an
  // unfiltered registry — so it is indexed off `matches`.
  expect(source).toContain("choose(matches[Number(event.key) - 1]);");
  expect(source).toContain("{at < QUICK_PICK_LIMIT && (");
});

test("the arrows wrap, and Enter takes the highlighted row", () => {
  expect(source).toContain("(current + delta + matches.length) % matches.length");
  expect(source).toContain('if (event.key === "Enter") {');
  expect(source).toContain("choose(matches[index]);");
});

test("an IME's Enter commits a candidate rather than choosing a project", () => {
  expect(source).toContain("composing.current || event.nativeEvent.isComposing || event.keyCode === 229");
});

test("the keyboard legend is drawn, because undiscoverable keys are a list you click", () => {
  expect(source).toContain("↑↓</kbd> Navigate");
  expect(source).toContain("Enter</kbd> Select");
  expect(source).toContain("Esc</kbd> Close");
});

test("the highlight is announced, not just drawn", () => {
  expect(source).toContain('role="listbox"');
  expect(source).toContain('role="option"');
  expect(source).toContain("aria-selected={on}");
  expect(source).toContain("aria-activedescendant");
});

test("the mouse and the arrows never disagree about what Enter would take", () => {
  expect(source).toContain("onMouseMove={() => setIndex(at)}");
});

test("choosing closes before it navigates, and opening starts from a blank query", () => {
  const choose = source.slice(source.indexOf("const choose ="));
  expect(choose.slice(0, 220)).toContain("onOpenChange(false)");
  expect(source).toContain("if (open !== wasOpen) {");
});

test("focus is the browser's — never a focus() call, which kills the WebKit build", () => {
  expect(source).toContain("autoFocus");
  // The prose above the component names `.focus()` to explain the ban, so the
  // check is for a real call — a ref or an element reached and focused.
  expect(/\b(current|ref|input|element)\??\.focus\(\)/.test(source)).toBe(false);
});

test("the empty state tells an empty registry apart from an empty search", () => {
  expect(source).toContain("No projects registered yet.");
  expect(source).toContain("No project matches that.");
});

test("the rail has one New-conversation control, and ⌘N opens the same thing", () => {
  // It used to be two: a plain button, and — only with a Mac paired — a menu.
  // Both now go through `newConversation`, which is the single place that
  // decides between the palette and a canvas.
  expect(sidebar).toContain("onClick={newConversation}");
  expect(sidebar).toContain('"new-conversation": () => newConversation(),');
  expect(sidebar).not.toContain('title="New conversation — choose where"');
});

test("a registry of one skips the palette rather than asking a question with one answer", () => {
  // A search field over a list of one row, to be told what the cockpit already
  // knew. The palette earns itself once there are two places to go.
  expect(sidebar).toContain("const soleTarget = pickerTargets.length === 1 ? pickerTargets[0] : undefined;");
  const decide = sidebar.slice(sidebar.indexOf("const newConversation ="));
  expect(decide.slice(0, 260)).toContain("if (soleTarget) startSession(");
  expect(decide.slice(0, 260)).toContain("else setPickerOpen(true);");
  // And the scope filter goes with it: "All projects" and "that one project"
  // select the same rows.
  expect(sidebar).toContain("{pickerTargets.length > 1 && (");
});

test("the palette is offered every project the rail already reads, this Mac's first", () => {
  const list = sidebar.slice(sidebar.indexOf("const pickerTargets"));
  expect(list.indexOf("projects.map")).toBeLessThan(list.indexOf("remoteProjects.map"));
  // And a chosen row opens that project's canvas on ITS Mac, host and all.
  expect(sidebar).toContain("startSession({ projectId: target.id, ...(target.hostId ? { hostId: target.hostId } : {}) })");
});
