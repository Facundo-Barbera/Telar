import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { err, failure, ok, type ToolFactory } from "./tool-kit";

export type DisplayCapability = {
  open(input: { path: string; title?: string }): Promise<{ path: string }>;
};

const OPEN = `Show the human a file from this checkout in the panel, rendered (markdown, PDF, image, video, code). For something you made for them to look at now.`;

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
  ];
}

export function createDisplayCapability(input: {
  cwd: string;
  report(observation: { path: string; title?: string }): Promise<void>;
}): DisplayCapability {
  return {
    async open({ path: target, title }) {
      const resolved = path.resolve(input.cwd, target);
      const prefix = input.cwd.endsWith(path.sep) ? input.cwd : `${input.cwd}${path.sep}`;
      if (!resolved.startsWith(prefix)) throw new Error("the path is outside this session's checkout");
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(resolved);
      } catch {
        throw new Error("no such file in this session's checkout — write it first, then display it");
      }
      if (stats.isDirectory()) throw new Error("that path is a directory; name one file");
      if (!stats.isFile()) throw new Error("that path is not a regular file");
      const relative = path.relative(input.cwd, resolved).split(path.sep).join("/");
      await input.report({ path: relative, ...(title ? { title } : {}) });
      return { path: relative };
    },
  };
}
