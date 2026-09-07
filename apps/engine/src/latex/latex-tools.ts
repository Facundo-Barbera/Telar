/**
 * `latex_*` — the document tools. Every one is a shaped call into the
 * session's compile capability; the shapes exist so a model gets structured
 * errors with file:line instead of grepping a 3000-line TeX log.
 *
 * TOOLS ALWAYS REGISTER when the project opted in; a handler that cannot
 * proceed answers a sentence naming what is missing, never hides — the same
 * discipline as `ds-tools.ts`.
 */
import { z } from "zod";
import { err, failure, json, ok, type ToolFactory } from "../tool-kit";
import type { LatexCapability } from "./capability";
import type { LatexDiagnostic } from "./log-parser";

function describeDiagnostics(diagnostics: LatexDiagnostic[]): string {
  if (!diagnostics.length) return "";
  return diagnostics
    .map((d) => {
      const where = d.file ? `${d.file}${d.line ? `:${d.line}` : ""} — ` : "";
      const hint = d.suggestion ? `\n    ${d.suggestion}` : "";
      return `${d.severity === "error" ? "ERROR" : "warn "} ${where}${d.message}${hint}`;
    })
    .join("\n");
}

export function latexTools(tool: ToolFactory, capability: LatexCapability): unknown[] {
  return [
    tool(
      "latex_compile",
      "Compile the project's main .tex file (or the one you name) to PDF and wait. Returns structured errors and warnings with file:line, and the PDF's path on success. The first Tectonic compile may download packages. Prefer fixing the FIRST error — TeX errors cascade.",
      {
        path: z.string().min(1).optional().describe("A .tex file relative to the session's tree. Default: the project's configured main file."),
        timeoutMs: z.number().int().min(10_000).max(3_600_000).optional().describe("Give up after this long. Default ten minutes."),
      },
      async (args) => {
        try {
          const result = await capability.compile({
            ...(typeof args.path === "string" ? { path: args.path } : {}),
            ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
          });
          const body = describeDiagnostics(result.diagnostics);
          if (result.ok) {
            const errors = result.diagnostics.filter((d) => d.severity === "error").length;
            return ok(`Compiled ${result.path}${result.pdfPath ? ` → ${result.pdfPath}` : ""}${errors ? ` with ${errors} error(s) swallowed by nonstopmode` : ""}.${body ? `\n${body}` : ""}`);
          }
          return err(`Compile of ${result.path} failed${result.error ? ` (${result.error})` : ""}.\n${body || result.logTail.join("\n")}`);
        } catch (error) {
          return err(`Could not compile: ${failure(error)}`);
        }
      },
    ),

    tool(
      "latex_status",
      "The last compile: ok or failed, its diagnostics and the PDF path. Cheap — call it before recompiling blind.",
      {},
      async () => {
        try {
          const status = await capability.status();
          if (status.status === "never") return ok("Nothing has been compiled in this session yet.");
          return json(status);
        } catch (error) {
          return err(`Could not read the compile status: ${failure(error)}`);
        }
      },
    ),

    tool(
      "latex_log",
      "A window of the raw compile log — the tail by default, around a line number, or around the first match of a string. For when the structured diagnostics are not enough.",
      {
        tail: z.number().int().min(1).max(400).optional().describe("The last N lines. Default 40."),
        around: z.number().int().min(1).optional().describe("Twenty lines either side of this log line."),
        find: z.string().min(1).optional().describe("The lines around the first case-insensitive match."),
      },
      async (args) => {
        try {
          const result = await capability.log({
            ...(typeof args.tail === "number" ? { tail: args.tail } : {}),
            ...(typeof args.around === "number" ? { around: args.around } : {}),
            ...(typeof args.find === "string" ? { find: args.find } : {}),
          });
          return ok(result.lines.length ? result.lines.join("\n") : "No compile log yet — compile first.");
        } catch (error) {
          return err(`Could not read the log: ${failure(error)}`);
        }
      },
    ),

    tool(
      "latex_toolchain",
      "Which TeX distribution this project compiles with — kind, engine, version, whether tlmgr manages packages — and what else the machine carries. Cheap.",
      {},
      async () => {
        try {
          return json(await capability.toolchain());
        } catch (error) {
          return err(`Could not read the toolchain: ${failure(error)}`);
        }
      },
    ),

    tool(
      "latex_packages",
      "Installed TeX packages when this project's distribution is tlmgr-managed; otherwise the sentence explaining how packages arrive here.",
      {},
      async () => {
        try {
          const answer = await capability.packages();
          if (answer.mode === "automatic") return ok(answer.note);
          if (answer.mode === "unavailable") return err(answer.reason);
          if (!answer.packages.length) return ok("No packages are installed beyond the distribution's core.");
          return ok(answer.packages.map((p) => `${p.name}${p.revision ? ` (r${p.revision})` : ""}${p.description ? `  ${p.description}` : ""}`).join("\n"));
        } catch (error) {
          return err(`Could not list packages: ${failure(error)}`);
        }
      },
    ),

    tool(
      "latex_install",
      "Install or remove TeX Live packages with tlmgr and wait for the result. Refused on Tectonic projects, which download packages automatically. Package names only — no flags, no versions.",
      {
        add: z.array(z.string().min(1)).optional().describe("tlmgr package names to install."),
        remove: z.array(z.string().min(1)).optional().describe("tlmgr package names to remove."),
      },
      async (args) => {
        try {
          const result = await capability.install({
            ...(Array.isArray(args.add) ? { add: args.add.map(String) } : {}),
            ...(Array.isArray(args.remove) ? { remove: args.remove.map(String) } : {}),
          });
          if (!result.ok) return err(result.error ?? result.lines.slice(-10).join("\n"));
          return ok(result.lines.slice(-20).join("\n") || "Done.");
        } catch (error) {
          return err(`Could not change packages: ${failure(error)}`);
        }
      },
    ),

    tool(
      "latex_clean",
      "Remove the compile's aux directory (and with pdf: true, the copied PDF) — the answer to a compile behaving strangely after refactors.",
      { pdf: z.boolean().optional().describe("Also remove the last compile's PDF.") },
      async (args) => {
        try {
          const result = await capability.clean({ ...(typeof args.pdf === "boolean" ? { pdf: args.pdf } : {}) });
          return ok(result.removed.length ? `Removed ${result.removed.join(", ")}.` : "Nothing to clean.");
        } catch (error) {
          return err(`Could not clean: ${failure(error)}`);
        }
      },
    ),
  ];
}
