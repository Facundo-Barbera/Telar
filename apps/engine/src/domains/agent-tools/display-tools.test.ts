/**
 * The `display` toolkit and the worker capability behind it.
 *
 * Two halves, tested apart the way they live apart: the TOOLKIT is a wrapper
 * whose contract is prose (what it answers, what it refuses to accept), and
 * the CAPABILITY is a fence whose contract is which paths get through it. The
 * fence tests use a real temp directory rather than fakes — the same policy
 * every engine tool test states — because prefix arithmetic over invented
 * strings is exactly where a fence bug would hide.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertTelarToolNames } from "@telar/engine-client";
import { createDisplayCapability } from "../src/display/capability";
import { displayTools, type DisplayCapability } from "../src/display/tools";

type Registered = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
};

function build(capability?: Partial<DisplayCapability>) {
  const registered: Registered[] = [];
  const opened: Array<{ path: string; title?: string }> = [];
  const factory = (
    name: string,
    description: string,
    shape: Record<string, unknown>,
    run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>,
  ) => {
    registered.push({ name, description, shape, run });
    return { name };
  };
  const full: DisplayCapability = {
    open:
      capability?.open ??
      (async (input) => {
        opened.push(input);
        return { path: input.path };
      }),
  };
  displayTools(factory, full);
  return { registered, opened };
}

function textOf(result: { content: unknown[] }): string {
  return (result.content as Array<{ type: string; text?: string }>)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join(" ");
}

describe("the display toolkit", () => {
  test("every tool declares the display capability in its name", () => {
    const { registered } = build();
    expect(registered.map((tool) => tool.name)).toEqual(["display_open"]);
    expect(() => assertTelarToolNames(registered.map((tool) => tool.name))).not.toThrow();
  });

  test("display_open forwards path and title and answers in prose, not content", async () => {
    const { registered, opened } = build();
    const result = await registered[0]!.run({ path: "docs/guide.md", title: "Setup guide" });
    expect(result.isError).toBeUndefined();
    expect(opened).toEqual([{ path: "docs/guide.md", title: "Setup guide" }]);
    // The tool result is a sentence about the gesture — never file content:
    // the agent has file tools for reading, and echoing bytes here would put
    // a whole document into the transcript for no reader.
    expect(textOf(result)).toContain("docs/guide.md");
    expect(textOf(result)).toContain("Setup guide");
  });

  test("a blank title is dropped rather than displayed as empty quotes", async () => {
    const { registered, opened } = build();
    await registered[0]!.run({ path: "a.md", title: "   " });
    expect(opened).toEqual([{ path: "a.md" }]);
  });

  test("a missing path is an instruction, not a throw", async () => {
    const { registered } = build();
    const result = await registered[0]!.run({});
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/path/i);
  });

  test("a capability refusal comes back as a sentence naming the path", async () => {
    const { registered } = build({
      open: async () => {
        throw new Error("no such file in this session's checkout — write it first, then display it");
      },
    });
    const result = await registered[0]!.run({ path: "missing.pdf" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("missing.pdf");
    expect(textOf(result)).toContain("write it first");
  });
});

describe("the worker's display capability (the fence)", () => {
  function checkout(): { cwd: string; cleanup: () => void } {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "telar-display-"));
    fs.mkdirSync(path.join(cwd, "docs"));
    fs.writeFileSync(path.join(cwd, "docs", "guide.md"), "# hi\n");
    return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
  }

  test("a relative path inside the checkout is verified, normalised and reported", async () => {
    const { cwd, cleanup } = checkout();
    try {
      const reports: Array<{ path: string; title?: string }> = [];
      const capability = createDisplayCapability({ cwd, report: async (observation) => void reports.push(observation) });
      const opened = await capability.open({ path: "docs/guide.md", title: "Guide" });
      expect(opened.path).toBe("docs/guide.md");
      expect(reports).toEqual([{ path: "docs/guide.md", title: "Guide" }]);
    } finally {
      cleanup();
    }
  });

  test("an absolute path inside the checkout is accepted and made relative", async () => {
    const { cwd, cleanup } = checkout();
    try {
      const reports: Array<{ path: string }> = [];
      const capability = createDisplayCapability({ cwd, report: async (observation) => void reports.push(observation) });
      const opened = await capability.open({ path: path.join(cwd, "docs", "guide.md") });
      expect(opened.path).toBe("docs/guide.md");
      expect(reports[0]!.path).toBe("docs/guide.md");
    } finally {
      cleanup();
    }
  });

  test("a path that walks out of the checkout is refused before any stat", async () => {
    const { cwd, cleanup } = checkout();
    try {
      const capability = createDisplayCapability({
        cwd,
        report: async () => {
          throw new Error("must not report a fenced-out path");
        },
      });
      await expect(capability.open({ path: "../outside.md" })).rejects.toThrow(/outside this session's checkout/);
      await expect(capability.open({ path: "/etc/hosts" })).rejects.toThrow(/outside this session's checkout/);
      // A sibling directory sharing the checkout's name as a PREFIX must not
      // slip the string comparison — the classic prefix-check bug.
      await expect(capability.open({ path: `${cwd}-sibling/file.md` })).rejects.toThrow(/outside this session's checkout/);
    } finally {
      cleanup();
    }
  });

  test("a missing file and a directory each refuse with their own sentence, unreported", async () => {
    const { cwd, cleanup } = checkout();
    try {
      const reports: unknown[] = [];
      const capability = createDisplayCapability({ cwd, report: async (observation) => void reports.push(observation) });
      await expect(capability.open({ path: "docs/absent.md" })).rejects.toThrow(/write it first/);
      await expect(capability.open({ path: "docs" })).rejects.toThrow(/directory/);
      expect(reports).toEqual([]);
    } finally {
      cleanup();
    }
  });
});
