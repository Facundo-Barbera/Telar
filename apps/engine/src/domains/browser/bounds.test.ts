import { afterEach, describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  BROWSER_ANSWER_BUDGETS,
  BROWSER_DESCRIPTION_MAX_BYTES,
  BROWSER_TOOLS,
  boundBrowserResult,
  boundBrowserText,
} from "../src/browser";
import { BrowserToolSocket, type BrowserSocketCapability } from "../src/browser/socket";

/**
 * THE CEILING ON A BROWSER ANSWER (#515 item 7).
 *
 * The fixtures are the ones `apps/desktop/browser-answer-size.test.js`
 * measures the renderers against — a 2,000-node tree, 500 console lines, 300
 * network rows — rebuilt here in the ANSWER's shape rather than the tree's,
 * because the engine bounds text and must not grow a dependency on the desktop
 * app to do it. The desktop test is what proves those shapes are what the host
 * actually emits.
 */

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

/** A rendered snapshot of roughly the size the desktop host's 500-line cap
 *  lets through: ~31 KB, which is about twice its budget. */
function snapshotAnswer(lines = 500): string {
  const rows = [`Page: Invoices — Acme`, `URL: https://acme.example.com/invoices`, ""];
  for (let i = 1; i <= lines; i++) {
    const indent = "  ".repeat(Math.min(12, i % 8));
    rows.push(`${indent}- button "Row ${i} — Open invoice ${100000 + i}" [ref=e${i}]`);
  }
  return rows.join("\n");
}

function consoleAnswer(count = 500): string {
  const levels = ["debug", "log", "info", "warning", "error"];
  return Array.from(
    { length: count },
    (_, i) => `[${levels[i % levels.length]}] [render] row ${i} recalculated in ${(i % 40) + 1}ms — cache miss for invoice ${100000 + i}`,
  ).join("\n");
}

function networkAnswer(count = 300): string {
  return Array.from(
    { length: count },
    (_, i) => `GET https://api.acme.example.com/v2/invoices/${100000 + i}/lines?include=tax,customer&page=${i % 7}`,
  ).join("\n");
}

describe("every heavy browser answer comes in under its budget", () => {
  const cases: [string, string, string][] = [
    ["browser_snapshot", snapshotAnswer(), "`target` or `depth`"],
    ["browser_console_messages", consoleAnswer(), "`level`"],
    ["browser_network_requests", networkAnswer(), "`filter`"],
  ];

  for (const [name, answer, narrow] of cases) {
    test(`${name}: over budget before, under it after, and the marker names the way out`, () => {
      const budget = BROWSER_ANSWER_BUDGETS[name]!;
      expect(bytes(answer)).toBeGreaterThan(budget);
      const bounded = boundBrowserText(name, answer);
      expect(bytes(bounded)).toBeLessThanOrEqual(budget);
      // The marker is machine-recognisable AND tells a model what to do next.
      expect(bounded).toMatch(/\[… \d+ more characters not shown — narrow with .+\]/);
      expect(bounded).toContain(narrow);
      console.log(`  ${name}: ${bytes(answer)} → ${bytes(bounded)} bytes (budget ${budget})`);
    });
  }

  test("the count in the marker is the characters actually dropped", () => {
    const answer = consoleAnswer();
    const bounded = boundBrowserText("browser_console_messages", answer);
    const reported = Number(/\[… (\d+) more characters/.exec(bounded)![1]);
    // The marker itself is not part of the answer it is reporting on.
    const kept = bounded.slice(bounded.indexOf("]\n") + 2);
    expect(reported).toBe(answer.length - kept.length);
  });

  test("an answer already under budget is returned byte-identical — no marker, no reflow", () => {
    const small = "Page: Example\nURL: https://example.com\n\n- button \"Save\" [ref=e1]";
    expect(boundBrowserText("browser_snapshot", small)).toBe(small);
    expect(boundBrowserText("browser_console_messages", "No console messages captured.")).toBe(
      "No console messages captured.",
    );
  });

  test("a tool with no budget is never touched", () => {
    const huge = "x".repeat(200_000);
    expect(boundBrowserText("browser_take_screenshot", huge)).toBe(huge);
    expect(boundBrowserText("browser_click", huge)).toBe(huge);
  });
});

describe("which end survives the cut", () => {
  test("the snapshot keeps its head: the page header and the outermost nodes", () => {
    const bounded = boundBrowserText("browser_snapshot", snapshotAnswer());
    expect(bounded.startsWith("Page: Invoices — Acme\nURL: https://acme.example.com/invoices")).toBe(true);
    expect(bounded).toContain("Row 1 —");
    expect(bounded).not.toContain("Row 500 —");
    // The marker is where the reader arrives at the cut.
    expect(bounded.trimEnd().endsWith("]")).toBe(true);
    expect(bounded.split("\n").at(-1)).toMatch(/^\[… /);
  });

  for (const [name, answer, newest, oldest] of [
    ["browser_console_messages", consoleAnswer(), "invoice 100499", "invoice 100000"],
    ["browser_network_requests", networkAnswer(), "invoices/100299/", "invoices/100000/"],
  ] as const) {
    test(`${name} keeps its tail — the newest entries get the budget, and the marker leads`, () => {
      const bounded = boundBrowserText(name, answer);
      expect(bounded).toContain(newest);
      expect(bounded).not.toContain(oldest);
      // Read order is unchanged: entries are not reshuffled, only dropped.
      expect(bounded.split("\n")[0]).toMatch(/^\[… /);
      const body = bounded.split("\n").slice(1);
      expect(body.at(-1)).toContain(newest);
    });
  }

  test("only whole lines are kept — half a ref or half a URL is worse than neither", () => {
    for (const [name, answer] of [
      ["browser_snapshot", snapshotAnswer()],
      ["browser_network_requests", networkAnswer()],
    ] as const) {
      const bounded = boundBrowserText(name, answer);
      const body = bounded.split("\n").filter((line) => !line.startsWith("[… "));
      for (const line of body) {
        if (line === "" || line.startsWith("Page: ") || line.startsWith("URL: ")) continue;
        expect(answer.split("\n")).toContain(line);
      }
    }
  });

  test("one line longer than the whole budget is cut inside itself rather than answered empty", () => {
    // The host caps a console entry's text at 2,000 characters, but nothing
    // caps how many of them a single `Log.entryAdded` becomes on a page that
    // logs an object graph — and a budget must survive a one-line answer.
    const single = `[error] ${"y".repeat(50_000)}`;
    const bounded = boundBrowserText("browser_console_messages", single);
    expect(bytes(bounded)).toBeLessThanOrEqual(BROWSER_ANSWER_BUDGETS.browser_console_messages!);
    expect(bounded.split("\n")[0]).toMatch(/^\[… /);
    expect(bounded).toContain("yyy");
  });

  test("a multi-byte answer is bounded by BYTES and never split mid-character", () => {
    const answer = Array.from({ length: 4000 }, (_, i) => `GET https://例え.example.com/請求書/${i}—💡`).join("\n");
    const bounded = boundBrowserText("browser_network_requests", answer);
    expect(bytes(bounded)).toBeLessThanOrEqual(BROWSER_ANSWER_BUDGETS.browser_network_requests!);
    // A lone surrogate would survive a JSON round trip as U+FFFD.
    expect(JSON.parse(JSON.stringify(bounded))).toBe(bounded);
    expect(bounded).not.toContain("�");
  });
});

describe("the result shape the bound hands back", () => {
  test("text blocks share one budget; an image rides through untouched", () => {
    const result = boundBrowserResult("browser_snapshot", {
      content: [
        { type: "text", text: snapshotAnswer(300) },
        { type: "text", text: snapshotAnswer(300) },
        { type: "image", data: "cG5n", mimeType: "image/png" },
      ],
    });
    const text = result.content.filter((block) => (block as { type: string }).type === "text");
    expect(text).toHaveLength(1);
    expect(bytes((text[0] as { text: string }).text)).toBeLessThanOrEqual(BROWSER_ANSWER_BUDGETS.browser_snapshot!);
    expect(result.content.at(-1)).toEqual({ type: "image", data: "cG5n", mimeType: "image/png" });
  });

  test("a result that fits comes back by reference — the common call is untouched", () => {
    const original = { content: [{ type: "text", text: "ok" }] };
    expect(boundBrowserResult("browser_snapshot", original)).toBe(original);
  });

  test("an isError result is bounded too, and stays an error", () => {
    const bounded = boundBrowserResult("browser_console_messages", {
      content: [{ type: "text", text: consoleAnswer() }],
      isError: true,
    });
    expect(bounded.isError).toBe(true);
    expect(bytes((bounded.content[0] as { text: string }).text)).toBeLessThanOrEqual(
      BROWSER_ANSWER_BUDGETS.browser_console_messages!,
    );
  });
});

describe("the bound is on the path a provider actually calls", () => {
  const sockets: BrowserToolSocket[] = [];
  afterEach(async () => {
    await Promise.all(sockets.splice(0).map((socket) => socket.close()));
  });

  test("a heavy snapshot crossing the real socket arrives bounded", async () => {
    const capability: BrowserSocketCapability = {
      call: async () => ({ content: [{ type: "text", text: snapshotAnswer() }] }),
      isReadOnly: () => true,
      tools: [{ name: "browser_snapshot", description: "look", input: z.object({}) }],
    };
    const socket = new BrowserToolSocket(capability);
    sockets.push(socket);
    const lease = await socket.bind({ scopeKey: "session_one" });
    const response = await fetch(lease.url, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${lease.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } }),
    });
    const body = (await response.json()) as { result: { content: { type: string; text: string }[] } };
    const text = body.result.content[0]!.text;
    expect(bytes(text)).toBeLessThanOrEqual(BROWSER_ANSWER_BUDGETS.browser_snapshot!);
    expect(text).toContain("narrow with `target` or `depth`");
  });
});

describe("what the toolkit costs before a single page is opened", () => {
  test("no description is over the cap, and the total is reported", () => {
    let total = 0;
    for (const tool of BROWSER_TOOLS) {
      const size = bytes(tool.description);
      total += size;
      expect({ tool: tool.name, size }).toMatchObject({ size: expect.any(Number) });
      if (size > BROWSER_DESCRIPTION_MAX_BYTES) {
        throw new Error(`${tool.name}'s description is ${size} bytes, over the ${BROWSER_DESCRIPTION_MAX_BYTES}-byte cap`);
      }
    }
    console.log(`  telar-browser descriptions: ${total} bytes across ${BROWSER_TOOLS.length} tools`);
    // The whole server's prose, in every browsing session's context. Raised
    // from 3,000 when the coordinate route joined: click and hover describe
    // both ways to address a page, and drag is a seventeenth tool.
    expect(total).toBeLessThan(3_600);
  });

  test("the three bounded tools say so, and name their narrowing argument", () => {
    const byName = new Map(BROWSER_TOOLS.map((tool) => [tool.name, tool.description]));
    expect(byName.get("browser_snapshot")).toContain("16 KB");
    expect(byName.get("browser_snapshot")).toContain("depth");
    expect(byName.get("browser_console_messages")).toContain("6 KB");
    expect(byName.get("browser_console_messages")).toContain("level");
    expect(byName.get("browser_network_requests")).toContain("6 KB");
    expect(byName.get("browser_network_requests")).toContain("filter");
  });
});
