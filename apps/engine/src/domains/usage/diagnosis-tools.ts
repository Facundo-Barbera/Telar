import { z } from "zod";
import { isTelarMcpServer, parseToolName, type RequestDecision, type RequestDetail, type UsageDiagnosisTool } from "@telar/engine-client";
import { err, failure, ok, type ToolFactory } from "../agent-tools";

export type UsageDiagnosisCapability = { call(tool: UsageDiagnosisTool, args: Record<string, unknown>): Promise<string> };

const USAGE_DIAGNOSIS_TOOL_NAMES = ["usage_read", "usage_grep", "usage_glob", "usage_sql"] as const;

export function diagnosisRequestDecision(detail: RequestDetail): RequestDecision {
  if (detail.kind !== "tool_call") return "decline";
  const { server, tool } = parseToolName(detail.call.name);
  return isTelarMcpServer(server ?? detail.call.server) && (USAGE_DIAGNOSIS_TOOL_NAMES as readonly string[]).includes(tool) ? "accept" : "decline";
}

const run = (capability: UsageDiagnosisCapability, tool: UsageDiagnosisTool) => async (args: Record<string, unknown>) => {
  try {
    return ok(await capability.call(tool, args));
  } catch (error) {
    return err(failure(error));
  }
};

export function usageDiagnosisTools(tool: ToolFactory, capability: UsageDiagnosisCapability): unknown[] {
  return [
    tool(
      "usage_read",
      "Read a text file, or list a folder, in Telar's data folder. Paths are relative to it.",
      {
        path: z.string().describe("Relative path, e.g. diagnostics/usage/<id>/digest.json."),
        offset: z.number().int().nonnegative().optional().describe("First line, 0-based."),
        limit: z.number().int().positive().optional().describe("Lines, at most 2000."),
      },
      run(capability, "read"),
    ),
    tool(
      "usage_grep",
      "Search text files in Telar's data folder for a regular expression. Skips the database and secrets.",
      {
        pattern: z.string(),
        path: z.string().optional().describe("Folder or file; default the whole data folder."),
        glob: z.string().optional().describe("File-name filter, e.g. *.json."),
        ignoreCase: z.boolean().optional(),
      },
      run(capability, "grep"),
    ),
    tool(
      "usage_glob",
      "List files in Telar's data folder matching a glob, with their sizes in bytes.",
      { pattern: z.string().describe("e.g. **/*.json"), path: z.string().optional() },
      run(capability, "glob"),
    ),
    tool(
      "usage_sql",
      "Run one read-only SELECT on Telar's execution database (execution.sqlite). At most 200 rows come back.",
      { query: z.string() },
      run(capability, "sql"),
    ),
  ];
}
