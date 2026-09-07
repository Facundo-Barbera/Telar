/**
 * The worker's half of `display_open` — the fence and the report.
 *
 * SEPARATE FROM tools.ts so the toolkit stays filesystem-free (the tool-kit.ts
 * rule), and separate from worker.ts so the fence is testable without a worker:
 * this is the same resolve-and-prefix check the store's `readFenced` applies,
 * restated here because the worker holds no store handle and the path must be
 * validated where the checkout actually is — beside the provider process.
 *
 * THE REPORT CARRIES THE RELATIVE PATH, always: the cockpit joins it against
 * the same workspace through the file routes, so an absolute path (which an
 * agent will eventually send) is accepted and normalised rather than refused.
 */
import fs from "node:fs";
import path from "node:path";
import type { DisplayCapability } from "./tools";

export function createDisplayCapability(input: {
  /** The turn's checkout root — `claim.projectRoot`, the one directory paths may name into. */
  cwd: string;
  /** Journal the gesture — the worker wires `reportObservations` here. */
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
