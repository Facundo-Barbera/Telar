/**
 * WHAT A HEAVY PAGE COSTS A MODEL — the measurement behind #515 item 7, kept
 * as a test so the numbers in that PR cannot quietly stop being true.
 *
 * The three answers that scale with the page rather than with the question are
 * rendered here over deliberately heavy fixtures — a 2,000-node accessibility
 * tree, 500 console lines, 300 network rows — because a browser may not be
 * launched to find this out and a live CDP session cannot be handed a page of
 * a chosen size. The renderers are pure for exactly this reason.
 *
 * The sizes asserted below are UPPER AND LOWER BOUNDS, not exact bytes: the
 * point is "tens of kilobytes, far past any sane context budget", and a test
 * that pins an exact length only ever fails for a reworded label.
 *
 * The engine puts the ceiling on (`apps/engine/src/browser/bounds.ts`); these
 * are the raw numbers it is a ceiling over.
 */
const { describe, expect, test } = require("bun:test");

const { renderSnapshot, renderConsole, renderNetwork, MAX_LOG_ITEMS, MAX_LOG_TEXT } = require("./browser-manager");

const bytes = (text) => Buffer.byteLength(text, "utf8");

/**
 * A branching accessibility tree of `count` nodes, roughly the shape a real
 * app page has: a root, three children per node, and a mix of roles where
 * about half are things an agent could click.
 */
function axTree(count) {
  const roles = ["button", "link", "textbox", "generic", "StaticText", "checkbox"];
  const nodes = [{ nodeId: "n0", role: { value: "RootWebArea" }, name: { value: "Invoices — Acme" } }];
  for (let i = 1; i < count; i++) {
    const role = roles[i % roles.length];
    nodes.push({
      nodeId: `n${i}`,
      parentId: `n${Math.floor((i - 1) / 3)}`,
      backendDOMNodeId: 1000 + i,
      role: { value: role },
      name: { value: `Row ${i} — ${role === "textbox" ? "Reference" : "Open invoice"} ${100000 + i}` },
      ...(role === "textbox" ? { value: { value: `INV-${100000 + i}` } } : {}),
    });
  }
  return nodes;
}

function consoleEntries(count) {
  const levels = ["debug", "log", "info", "warning", "error"];
  return Array.from({ length: count }, (_, i) => ({
    level: levels[i % levels.length],
    text: `[render] row ${i} recalculated in ${(i % 40) + 1}ms — cache ${i % 3 === 0 ? "miss" : "hit"} for invoice ${100000 + i}`,
  }));
}

function networkEntries(count) {
  const methods = ["GET", "POST", "GET", "GET"];
  return Array.from({ length: count }, (_, i) => ({
    method: methods[i % methods.length],
    url: `https://api.acme.example.com/v2/invoices/${100000 + i}/lines?include=tax,customer&page=${i % 7}`,
  }));
}

describe("what a heavy page answers, before anything bounds it", () => {
  test("a 2,000-node tree renders tens of kilobytes — the line cap is not a byte cap", () => {
    const { text, refs } = renderSnapshot(axTree(2000), { title: "Invoices — Acme", url: "https://acme.example.com/invoices" });
    // The 500-line cap is the ONLY thing holding this down today, and a line
    // carries a role, a name, a value and a ref: ~60 bytes each, so the cap
    // lands the answer an order of magnitude over a sensible budget.
    expect(text.split("\n").length).toBeLessThanOrEqual(501);
    expect(bytes(text)).toBeGreaterThan(24_000);
    expect(refs.size).toBeGreaterThan(200);
    // Reported in the PR as the BEFORE number for browser_snapshot.
    console.log(`  browser_snapshot, 2,000 nodes: ${bytes(text)} bytes, ${text.split("\n").length} lines`);
  });

  test("500 console lines render tens of kilobytes, and the ring's own worst case is far worse", () => {
    const text = renderConsole(consoleEntries(500), { all: true });
    expect(bytes(text)).toBeGreaterThan(30_000);
    console.log(`  browser_console_messages, 500 lines: ${bytes(text)} bytes`);
    // The ring holds 200 entries whose text is capped at 2,000 characters
    // EACH, so "a heavy page" is not the ceiling — this is.
    expect(MAX_LOG_ITEMS * MAX_LOG_TEXT).toBeGreaterThanOrEqual(400_000);
  });

  test("300 network rows render tens of kilobytes", () => {
    const text = renderNetwork(networkEntries(300));
    expect(bytes(text)).toBeGreaterThan(15_000);
    console.log(`  browser_network_requests, 300 rows: ${bytes(text)} bytes`);
  });
});

describe("the narrowing arguments the bound's marker names", () => {
  test("depth cuts the tree off at a level, counted from what is being rendered", () => {
    const nodes = axTree(2000);
    const whole = renderSnapshot(nodes, { title: "t", url: "u" });
    const shallow = renderSnapshot(nodes, { title: "t", url: "u", maxDepth: 2 });
    expect(bytes(shallow.text)).toBeLessThan(bytes(whole.text) / 4);
    // Nothing deeper than the asked-for level survives: every body line is
    // indented by at most `depth` steps of two spaces.
    for (const line of shallow.text.split("\n").slice(3)) {
      expect(line.length - line.trimStart().length).toBeLessThanOrEqual(4);
    }
  });

  test("target renders one subtree, with refs minted fresh inside it", () => {
    const nodes = axTree(2000);
    const whole = renderSnapshot(nodes, { title: "t", url: "u" });
    // n40's subtree: a node well inside the document, not the root.
    const narrowed = renderSnapshot(nodes, { title: "t", url: "u", rootNodeId: "n40" });
    expect(bytes(narrowed.text)).toBeLessThan(bytes(whole.text) / 4);
    expect(narrowed.text).toContain("Row 40 —");
    // A sibling subtree is NOT in it.
    expect(narrowed.text).not.toContain("Row 41 —");
    // Refs restart: a ref belongs to the snapshot that minted it, always.
    expect([...narrowed.refs.keys()][0]).toBe("e1");
  });

  test("target and depth compose: that node and its children only", () => {
    const narrowed = renderSnapshot(axTree(2000), { title: "t", url: "u", rootNodeId: "n40", maxDepth: 1 });
    const body = narrowed.text.split("\n").slice(3);
    expect(body.length).toBeGreaterThan(1);
    for (const line of body) expect(line.length - line.trimStart().length).toBeLessThanOrEqual(2);
  });

  test("an unnamed, untargetable node is still skipped, and the root is still the root", () => {
    const { text } = renderSnapshot(
      [
        { nodeId: "r", role: { value: "RootWebArea" }, name: { value: "Page" } },
        { nodeId: "quiet", parentId: "r", role: { value: "generic" } },
        { nodeId: "ignored", parentId: "r", ignored: true, backendDOMNodeId: 9, role: { value: "button" }, name: { value: "Hidden" } },
        { nodeId: "real", parentId: "r", backendDOMNodeId: 10, role: { value: "button" }, name: { value: "Save" } },
      ],
      { title: "Page", url: "https://example.com" },
    );
    expect(text).toContain('button "Save" [ref=e1]');
    expect(text).not.toContain("Hidden");
    expect(text.split("\n").filter((line) => line.startsWith("- ") || line.startsWith("  "))).toHaveLength(2);
  });

  test("level is a floor on the console, and `all` is the way back to everything", () => {
    const entries = consoleEntries(500);
    const errorsOnly = renderConsole(entries, { level: "error" });
    expect(errorsOnly.split("\n").every((line) => line.startsWith("[error]"))).toBe(true);
    expect(bytes(errorsOnly)).toBeLessThan(bytes(renderConsole(entries, { all: true })) / 4);
    // "warning" is a floor, so errors come with it.
    const warnings = renderConsole(entries, { level: "warning" });
    expect(warnings).toContain("[error]");
    expect(warnings).not.toContain("[debug]");
    // The default hides debug, which is what the schema has always said.
    expect(renderConsole(entries, {})).not.toContain("[debug]");
    expect(renderConsole(entries, { all: true })).toContain("[debug]");
  });

  test("a level that matches nothing says so, and says how to see the rest", () => {
    const quiet = renderConsole([{ level: "debug", text: "tick" }], { level: "error" });
    expect(quiet).toContain("all: true");
    expect(renderConsole([], {})).toBe("No console messages captured.");
  });

  test("filter is a substring of the URL, and an empty match says how many there were", () => {
    const entries = networkEntries(300);
    const filtered = renderNetwork(entries, { filter: "/100007/" });
    expect(filtered.split("\n")).toHaveLength(1);
    expect(renderNetwork(entries, { filter: "nothing-matches-this" })).toContain("300 captured");
    expect(renderNetwork([], {})).toBe("No network requests captured.");
  });
});
