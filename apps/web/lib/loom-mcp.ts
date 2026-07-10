// The "loom" in-process MCP server (docs/loom-model.md §5, §M.6) — the
// moat-safe toolset a planning session gets: draft/refine a Spec Bundle,
// propose its falsifiable Verification Contract, inspect looms, and —
// gated entirely outside this module, see route.ts's allowedTools/PreToolUse
// wiring — commit a draft into a running loom. Modeled on engine.ts's
// `agent()` (createSdkMcpServer + tool() + zod), but long-lived for a whole
// chat turn rather than scoped to one agent() call.
//
// No tool here sets a loom's state/verdict/acceptance. `start_loom` is the
// only mutation that dispatches a loom, and the `by` identity it stamps as
// provenance is always server-derived (the chat's own account), NEVER read
// from tool input — the model cannot name who approved its own commit.
import { createSdkMcpServer, tool, type McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import {
  ContractAssertion,
  createDraftLoom,
  getLoom,
  isListableLoom,
  listAccounts,
  listBundleFiles,
  listLooms,
  loadPolicy,
  readContract,
  saveLoom,
  startLoomFromBundle,
  writeBundleFile,
  writeContract,
} from "@telar/core";

// The read/draft tools — safe to auto-run (route.ts adds these, and only
// these, to `allowedTools`). Named here so the allow-list and the server
// definition below can never drift apart.
export const LOOM_AUTO_TOOLS = [
  "mcp__loom__draft_bundle_file",
  "mcp__loom__propose_contract",
  "mcp__loom__read_bundle",
  "mcp__loom__list_looms",
  "mcp__loom__get_loom",
] as const;

// The commit tool — deliberately NEVER added to `allowedTools` and hard-routed
// back to an interactive approval by route.ts's PreToolUse guardrail hook
// regardless of permissionMode (§M.6 — the human's Approve click IS the
// provenance stamp). See route.ts's preToolUseGuardrail and canUseTool.
export const LOOM_START_TOOL = "mcp__loom__start_loom";

// Mutated in place by draft_bundle_file (first-use lazy create) and read back
// by route.ts after the turn ends to persist onto the chat record via the
// same appendTurn(loomId, role) path used for every other captured session
// state — see store.ts's Chat.loomId/role.
export type LoomSessionLink = { loomId?: string; role?: "planner" | "steerer" };

export type LoomMcpOpts = {
  project: string;
  // The turn's raw user message — used only to seed a lazily-created draft
  // loom's title/objective on first use; never re-read after that.
  objectiveSeed: string;
  // Server-derived human/account identity for this chat — the ONLY source
  // start_loom's `by`/provenance ever draws from.
  account: string;
  link: LoomSessionLink;
  // Tool calls always run after the SDK's system:init message, so by the
  // time any handler below fires, route.ts's capturedSession is already set
  // — read lazily rather than captured at server-construction time.
  getSessionId: () => string | null;
};

const errResult = (message: string) => ({
  content: [{ type: "text" as const, text: message }],
  isError: true,
});
const okResult = (text: string) => ({ content: [{ type: "text" as const, text }] });

export function createLoomMcpServer(opts: LoomMcpOpts): McpServerConfig {
  // Shared by every tool below except draft_bundle_file (which lazily
  // creates the draft loom instead of erroring).
  const requireLoomId = (): string | null => opts.link.loomId ?? null;

  return createSdkMcpServer({
    name: "loom",
    version: "1.0.0",
    tools: [
      tool(
        "draft_bundle_file",
        "Write (or overwrite) one file into this session's draft Spec Bundle — the working directory the loom will weave from. Creates the draft loom on first use. Path is relative to the bundle root (e.g. 'objective.md', 'contract.json').",
        { path: z.string(), contents: z.string() },
        async ({ path, contents }) => {
          if (!opts.link.loomId) {
            const title = opts.objectiveSeed.trim().slice(0, 60) || "Untitled loom";
            const draft = createDraftLoom({
              project: opts.project,
              title,
              objective: opts.objectiveSeed,
              account: opts.account,
            });
            opts.link.loomId = draft.id;
            opts.link.role = "planner";
          }
          try {
            writeBundleFile(opts.link.loomId, path, contents);
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
          return okResult(`Wrote "${path}" to the draft bundle (loom ${opts.link.loomId}).`);
        },
      ),
      tool(
        "propose_contract",
        "Write this draft loom's Verification Contract (spec/contract.json) — the required, falsifiable proof spec. Each assertion must be falsifiable by construction (a concrete `expected`/`expectedFile`, or an `observable` for live-critic entries); a prose-only/non-falsifiable contract is REJECTED — the tool result will report exactly why so you can fix it.",
        { assertions: z.array(ContractAssertion) },
        async ({ assertions }) => {
          const loomId = requireLoomId();
          if (!loomId) {
            return errResult("No draft loom yet — call draft_bundle_file first to start one.");
          }
          try {
            writeContract(loomId, { version: 1, assertions });
          } catch (e) {
            // writeContract THROWS on an unfalsifiable contract (§M.1) — the
            // thrown message IS the tool result, so the model sees exactly
            // what to fix rather than a silently swallowed failure.
            return errResult(e instanceof Error ? e.message : String(e));
          }
          return okResult(`Verification Contract written with ${assertions.length} assertion(s).`);
        },
      ),
      tool(
        "read_bundle",
        "List this draft loom's bundle files and its current Verification Contract (if any), so you can review what's been drafted so far.",
        {},
        async () => {
          const loomId = requireLoomId();
          if (!loomId) {
            return okResult("No draft loom yet — nothing has been drafted.");
          }
          const files = listBundleFiles(loomId);
          const { contract, errors } = readContract(loomId);
          return okResult(JSON.stringify({ loomId, files, contract, contractErrors: errors }, null, 2));
        },
      ),
      tool(
        "list_looms",
        "List started, top-level looms (drafts-in-progress and child/thread looms are excluded).",
        {},
        async () => {
          const looms = listLooms()
            .filter(isListableLoom)
            .map((l) => ({ id: l.id, title: l.title, project: l.project, state: l.state, updatedAt: l.updatedAt }));
          return okResult(JSON.stringify(looms, null, 2));
        },
      ),
      tool(
        "get_loom",
        "Get the full status of one loom by id (works for a draft, in the current session, too).",
        { id: z.string() },
        async ({ id }) => {
          const loom = getLoom(id);
          if (!loom) return errResult(`No loom found with id "${id}".`);
          return okResult(JSON.stringify(loom, null, 2));
        },
      ),
      tool(
        "start_loom",
        "COMMIT this draft Spec Bundle and start the loom running — the moment automation begins spending. This tool ALWAYS requires the human's explicit interactive approval in Telar's UI, in every permission mode; it can never auto-run. Only call it once you and the human are confident the bundle (objective + falsifiable Verification Contract) is ready.",
        { title: z.string().optional() },
        async ({ title }) => {
          const loomId = requireLoomId();
          if (!loomId) {
            return errResult("No draft loom yet — call draft_bundle_file first to start one.");
          }
          if (title?.trim()) {
            const loom = getLoom(loomId);
            if (loom) {
              loom.title = title.trim();
              saveLoom(loom);
            }
          }
          try {
            // `by` is opts.account — the chat's own server-resolved identity,
            // never a value read from tool input (§M.6).
            const started = await startLoomFromBundle(
              loomId,
              opts.account,
              { accounts: Object.fromEntries(listAccounts().map((a) => [a.name, a])), policy: loadPolicy() },
              { sessionId: opts.getSessionId() ?? undefined },
            );
            return okResult(JSON.stringify({ loomId: started.id, url: `/looms/${started.id}` }, null, 2));
          } catch (e) {
            return errResult(e instanceof Error ? e.message : String(e));
          }
        },
      ),
    ],
  });
}
