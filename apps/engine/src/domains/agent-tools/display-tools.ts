import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type Artifact, ArtifactId, ArtifactKind, MAX_ARTIFACT_BYTES } from "@telar/engine-client";
import { err, failure, ok, type ToolFactory } from "./tool-kit";

type InlineInput = { kind: ArtifactKind; title: string; id?: string; content?: string; path?: string };

export type DisplayCapability = {
  open(input: { path: string; title?: string }): Promise<{ path: string }>;
  inline(input: InlineInput): Promise<{ id: string }>;
};

const OPEN = `Show the human a file from this checkout in the panel, rendered (markdown, PDF, image, video, code). For something you made for them to look at now.`;

const INLINE = `Draw something in the conversation itself: an html page, an svg, a mermaid diagram or markdown. Suits diagrams, charts, UI mockups, comparisons and visual explanations.
Html runs sandboxed with no network, so inline every script, style and image. Pass the same id again to revise an artifact; the card shows the newest version.`;

export function displayTools(tool: ToolFactory, capability: DisplayCapability): unknown[] {
  return [
    tool(
      "display_open",
      OPEN,
      {
        path: z.string().min(1).describe("Relative to the checkout root."),
        title: z.string().max(200).optional().describe("Shown beside the file."),
      },
      async (args) => {
        const path = typeof args.path === "string" ? args.path.trim() : "";
        if (!path) return err("Name the file to show (path, relative to the checkout root).");
        const title = typeof args.title === "string" && args.title.trim() ? args.title.trim() : undefined;
        try {
          const opened = await capability.open({ path, ...(title ? { title } : {}) });
          return ok(
            `Opened ${opened.path} in the right panel${title ? ` as "${title}"` : ""}. The human is looking at the rendered file, not its source; nothing further is needed unless you want to walk them through it.`,
          );
        } catch (error) {
          return err(`Could not display "${path}": ${failure(error)}`);
        }
      },
    ),
    tool(
      "display_inline",
      INLINE,
      {
        kind: ArtifactKind.describe("How to render it."),
        title: z.string().min(1).max(200).describe("Shown above the artifact."),
        content: z.string().optional().describe("The source. Give this or path."),
        path: z.string().optional().describe("A file in the checkout holding the source, relative to its root."),
        id: z.string().optional().describe("Reuse an earlier artifact's id to add a new version of it."),
      },
      async (args) => {
        const kind = ArtifactKind.safeParse(args.kind);
        if (!kind.success) return err(`Name a kind: ${ArtifactKind.options.join(", ")}.`);
        const title = typeof args.title === "string" ? args.title.trim().slice(0, 200) : "";
        if (!title) return err("Give the artifact a title.");
        const content = typeof args.content === "string" && args.content.length > 0 ? args.content : undefined;
        const file = typeof args.path === "string" && args.path.trim() ? args.path.trim() : undefined;
        if ((content === undefined) === (file === undefined)) return err("Give exactly one of content or path.");
        const id = typeof args.id === "string" && args.id.trim() ? args.id.trim() : undefined;
        if (id !== undefined && !ArtifactId.safeParse(id).success) return err("An id is 1-64 letters, digits, dashes or underscores.");
        try {
          const shown = await capability.inline({ kind: kind.data, title, ...(id ? { id } : {}), ...(content !== undefined ? { content } : {}), ...(file ? { path: file } : {}) });
          return ok(`Showing "${title}" in the conversation as artifact ${shown.id}. To revise it, call display_inline again with id "${shown.id}".`);
        } catch (error) {
          return err(`Could not show "${title}": ${failure(error)}`);
        }
      },
    ),
  ];
}

type DisplayObservation =
  | { kind: "display.opened"; path: string; title?: string }
  | { kind: "artifact.published"; artifact: Omit<Artifact, "version"> };

const tooLarge = (bytes: number) =>
  `it is ${Math.ceil(bytes / 1024)} KB and the limit is ${MAX_ARTIFACT_BYTES / 1024} KB; make it smaller, or write it to a file and use display_open`;

async function checkoutFile(cwd: string, target: string): Promise<{ resolved: string; relative: string; stats: fs.Stats }> {
  const inside = (root: string, candidate: string) => candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
  const resolved = path.resolve(cwd, target);
  if (!inside(cwd, resolved)) throw new Error("the path is outside this session's checkout");
  let stats: fs.Stats;
  try {
    stats = await fs.promises.stat(resolved);
  } catch {
    throw new Error("no such file in this session's checkout — write it first, then display it");
  }
  if (stats.isDirectory()) throw new Error("that path is a directory; name one file");
  if (!stats.isFile()) throw new Error("that path is not a regular file");
  if (!inside(await fs.promises.realpath(cwd), await fs.promises.realpath(resolved))) throw new Error("the path is outside this session's checkout");
  return { resolved, relative: path.relative(cwd, resolved).split(path.sep).join("/"), stats };
}

export function createDisplayCapability(input: {
  cwd: string;
  report(observation: DisplayObservation): Promise<void>;
  upload(file: { name: string; mediaType: string; data: Uint8Array }): Promise<{ id: string }>;
}): DisplayCapability {
  return {
    async open({ path: target, title }) {
      const { relative } = await checkoutFile(input.cwd, target);
      await input.report({ kind: "display.opened", path: relative, ...(title ? { title } : {}) });
      return { path: relative };
    },
    async inline({ kind, title, id = `art_${crypto.randomUUID().slice(0, 8)}`, content, path: target }) {
      let data: Uint8Array;
      if (target !== undefined) {
        const { resolved, stats } = await checkoutFile(input.cwd, target);
        if (stats.size > MAX_ARTIFACT_BYTES) throw new Error(tooLarge(stats.size));
        data = new Uint8Array(await fs.promises.readFile(resolved));
      } else {
        data = new TextEncoder().encode(content ?? "");
      }
      if (data.byteLength === 0) throw new Error("the artifact is empty");
      if (data.byteLength > MAX_ARTIFACT_BYTES) throw new Error(tooLarge(data.byteLength));
      // Stored as plain text whatever the kind, so the bytes route can never serve it as a page.
      const attachment = await input.upload({ name: `${id}.txt`, mediaType: "text/plain", data });
      await input.report({ kind: "artifact.published", artifact: { id, kind, title, attachmentId: attachment.id } });
      return { id };
    },
  };
}
