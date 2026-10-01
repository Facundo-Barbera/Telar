import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertTelarToolNames, MAX_ARTIFACT_BYTES } from "@telar/engine-client";
import { createDisplayCapability, type DisplayCapability, displayTools } from "./display-tools";

type Registered = {
  name: string;
  description: string;
  shape: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<{ content: unknown[]; isError?: boolean }>;
};

function build(capability?: Partial<DisplayCapability>) {
  const registered: Registered[] = [];
  const opened: Array<{ path: string; title?: string }> = [];
  const inlined: Array<Parameters<DisplayCapability["inline"]>[0]> = [];
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
    inline:
      capability?.inline ??
      (async (input) => {
        inlined.push(input);
        return { id: input.id ?? "art_minted" };
      }),
  };
  displayTools(factory, full);
  const named = (name: string) => registered.find((tool) => tool.name === name)!;
  return { registered, opened, inlined, named };
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
    expect(registered.map((tool) => tool.name)).toEqual(["display_open", "display_inline"]);
    expect(() => assertTelarToolNames(registered.map((tool) => tool.name))).not.toThrow();
  });

  test("display_open forwards path and title and answers in prose, not content", async () => {
    const { registered, opened } = build();
    const result = await registered[0]!.run({ path: "docs/guide.md", title: "Setup guide" });
    expect(result.isError).toBeUndefined();
    expect(opened).toEqual([{ path: "docs/guide.md", title: "Setup guide" }]);
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

const fence = (input: Omit<Parameters<typeof createDisplayCapability>[0], "upload">) =>
  createDisplayCapability({ ...input, upload: async () => ({ id: "att_1" }) });

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
      const reports: unknown[] = [];
      const capability = fence({ cwd, report: async (observation) => void reports.push(observation) });
      const opened = await capability.open({ path: "docs/guide.md", title: "Guide" });
      expect(opened.path).toBe("docs/guide.md");
      expect(reports).toEqual([{ kind: "display.opened", path: "docs/guide.md", title: "Guide" }]);
    } finally {
      cleanup();
    }
  });

  test("an absolute path inside the checkout is accepted and made relative", async () => {
    const { cwd, cleanup } = checkout();
    try {
      const reports: unknown[] = [];
      const capability = fence({ cwd, report: async (observation) => void reports.push(observation) });
      const opened = await capability.open({ path: path.join(cwd, "docs", "guide.md") });
      expect(opened.path).toBe("docs/guide.md");
      expect(reports).toEqual([{ kind: "display.opened", path: "docs/guide.md" }]);
    } finally {
      cleanup();
    }
  });

  test("a path that walks out of the checkout is refused before any stat", async () => {
    const { cwd, cleanup } = checkout();
    try {
      const capability = fence({
        cwd,
        report: async () => {
          throw new Error("must not report a fenced-out path");
        },
      });
      await expect(capability.open({ path: "../outside.md" })).rejects.toThrow(/outside this session's checkout/);
      await expect(capability.open({ path: "/etc/hosts" })).rejects.toThrow(/outside this session's checkout/);
      await expect(capability.open({ path: `${cwd}-sibling/file.md` })).rejects.toThrow(/outside this session's checkout/);
    } finally {
      cleanup();
    }
  });

  test("a missing file and a directory each refuse with their own sentence, unreported", async () => {
    const { cwd, cleanup } = checkout();
    try {
      const reports: unknown[] = [];
      const capability = fence({ cwd, report: async (observation) => void reports.push(observation) });
      await expect(capability.open({ path: "docs/absent.md" })).rejects.toThrow(/write it first/);
      await expect(capability.open({ path: "docs" })).rejects.toThrow(/directory/);
      expect(reports).toEqual([]);
    } finally {
      cleanup();
    }
  });
});

describe("display_inline", () => {
  test("forwards the artifact and answers with its id, never its content", async () => {
    const { named, inlined } = build();
    const content = "<svg><text>secret-marker</text></svg>";
    const result = await named("display_inline").run({ kind: "svg", title: "Chart", content, id: "chart" });
    expect(result.isError).toBeUndefined();
    expect(inlined).toEqual([{ kind: "svg", title: "Chart", content, id: "chart" }]);
    expect(textOf(result)).toContain("chart");
    expect(textOf(result)).not.toContain("secret-marker");
  });

  test("refuses a call with both or neither of content and path, a bad kind or a bad id", async () => {
    const { named, inlined } = build();
    const run = named("display_inline").run;
    expect((await run({ kind: "svg", title: "A" })).isError).toBe(true);
    expect((await run({ kind: "svg", title: "A", content: "x", path: "a.svg" })).isError).toBe(true);
    expect(textOf(await run({ kind: "png", title: "A", content: "x" }))).toContain("html, svg, markdown, mermaid");
    expect(textOf(await run({ kind: "svg", title: "A", content: "x", id: "../etc" }))).toMatch(/letters, digits/);
    expect(inlined).toEqual([]);
  });
});

describe("the worker's inline capability", () => {
  function inline(cwd: string) {
    const uploads: Array<{ name: string; mediaType: string; data: string }> = [];
    const reports: unknown[] = [];
    const capability = createDisplayCapability({
      cwd,
      report: async (observation) => void reports.push(observation),
      upload: async (file) => {
        uploads.push({ name: file.name, mediaType: file.mediaType, data: new TextDecoder().decode(file.data) });
        return { id: `att_${uploads.length}` };
      },
    });
    return { capability, uploads, reports };
  }

  test("stores the content as plain text and reports the artifact under its id", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "telar-inline-"));
    try {
      const { capability, uploads, reports } = inline(cwd);
      expect(await capability.inline({ kind: "html", title: "Page", content: "<p>hi</p>", id: "page" })).toEqual({ id: "page" });
      expect(uploads).toEqual([{ name: "page.txt", mediaType: "text/plain", data: "<p>hi</p>" }]);
      expect(reports).toEqual([{ kind: "artifact.published", artifact: { id: "page", kind: "html", title: "Page", attachmentId: "att_1" } }]);
      const minted = await capability.inline({ kind: "markdown", title: "Notes", content: "# hi" });
      expect(minted.id).toMatch(/^art_[a-f0-9]{8}$/);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("reads a checkout file, and refuses one outside it or behind a symlink out of it", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "telar-inline-"));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "telar-outside-"));
    try {
      fs.writeFileSync(path.join(cwd, "flow.mmd"), "graph TD; A-->B");
      fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(cwd, "link.txt"));
      const { capability, uploads } = inline(cwd);
      await capability.inline({ kind: "mermaid", title: "Flow", path: "flow.mmd" });
      expect(uploads.map((upload) => upload.data)).toEqual(["graph TD; A-->B"]);
      await expect(capability.inline({ kind: "markdown", title: "X", path: "../x.md" })).rejects.toThrow(/outside this session's checkout/);
      await expect(capability.inline({ kind: "markdown", title: "X", path: "link.txt" })).rejects.toThrow(/outside this session's checkout/);
      expect(uploads).toHaveLength(1);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses anything over the size limit, from content or from a file, before storing it", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "telar-inline-"));
    try {
      const big = "x".repeat(MAX_ARTIFACT_BYTES + 1);
      fs.writeFileSync(path.join(cwd, "big.html"), big);
      const { capability, uploads, reports } = inline(cwd);
      await expect(capability.inline({ kind: "html", title: "Big", content: big })).rejects.toThrow(/limit is 512 KB/);
      await expect(capability.inline({ kind: "html", title: "Big", path: "big.html" })).rejects.toThrow(/limit is 512 KB/);
      expect(uploads).toEqual([]);
      expect(reports).toEqual([]);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
