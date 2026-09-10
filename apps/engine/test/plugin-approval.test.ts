/**
 * WHO DECIDES THAT A PLUGIN'S TOOL IS A READ — and does BOTH providers agree.
 *
 * Two root-review conditions meet in this file:
 *
 *   1. The HOST owns approval policy. A plugin manifest's `readTools` is a
 *      claim, and a claim is not a grant: `plugins/policy.ts` holds the table
 *      that actually classifies, and a plugin editing its own manifest cannot
 *      widen what it is allowed to do without an approval card.
 *   2. The answer must be THE SAME ON CLAUDE AND ON CODEX. The two providers ask
 *      the question through completely different wires — Claude reports a
 *      qualified tool name, Codex sends an MCP *elicitation* with the approval
 *      hidden in `_meta` — and before this change the Codex arm answered
 *      `"tool_call"` unconditionally. That made `spool_list_items` auto-accept
 *      under one provider and park a card under the other, for the same read.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { codexApprovalRequest, MCP_ELICITATION } from "../src/codex/items";
import { requestKindForTool, setPluginReadTools } from "../src/driver";
import { HOST_RATIFIED_READ_TOOLS, ratifiedReadTools } from "../src/plugins/policy";

/** The default the module boots with, restored after any test that installs. */
const defaults = new Set(Object.values(HOST_RATIFIED_READ_TOOLS).flat());
afterEach(() => setPluginReadTools(defaults));

/** How Codex asks. The tool name lives only inside the prose. */
const codexAsks = (server: string, tool: string) =>
  codexApprovalRequest(MCP_ELICITATION, {
    serverName: server,
    message: `Allow the ${server} MCP server to run tool "${tool}"?`,
    _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
  });

/** How Claude asks: the qualified name, classified directly. */
const claudeAsks = (server: string, tool: string) => requestKindForTool(`mcp__${server}__${tool}`);

describe("both providers classify a tool the same way", () => {
  const cases: { tool: string; kind: string; why: string }[] = [
    { tool: "spool_list_items", kind: "file_read", why: "a core read" },
    { tool: "ds_packages", kind: "file_read", why: "a plugin read the host ratified" },
    { tool: "ds_kernel", kind: "file_read", why: "a plugin read the host ratified" },
    { tool: "notebook_run_cell", kind: "tool_call", why: "a plugin tool that executes" },
    { tool: "ds_install", kind: "tool_call", why: "a plugin tool that writes to the environment" },
    { tool: "latex_compile", kind: "tool_call", why: "a plugin tool that writes" },
    { tool: "latex_status", kind: "tool_call", why: "NOT promoted by the migration" },
    { tool: "spool_create_item", kind: "tool_call", why: "a core write" },
  ];

  for (const { tool, kind, why } of cases) {
    test(`${tool} is ${kind} on both providers — ${why}`, () => {
      expect(claudeAsks("telar", tool)).toBe(kind as never);
      expect(codexAsks("telar", tool)?.kind).toBe(kind as never);
    });
  }

  test("a user's own MCP server never inherits the engine's posture, on either provider", () => {
    // Somebody else's server naming a tool `ds_packages` gets no privilege from
    // the coincidence.
    expect(claudeAsks("linear", "ds_packages")).toBe("tool_call");
    expect(codexAsks("linear", "ds_packages")?.kind).toBe("tool_call");
  });

  test("the Codex card still names the tool the way every other row names it", () => {
    // Parity of KIND must not have cost the detail its identity: an approval
    // card and the timeline row it is about spell the same string.
    const request = codexAsks("telar", "ds_packages");
    expect(request?.detail).toMatchObject({
      kind: "tool_call",
      call: { name: "mcp__telar__ds_packages", server: "telar" },
    });
  });

  test("an elicitation that is not an approval is still declined by both", () => {
    // A server legitimately eliciting input — a form, a URL — has no
    // `codex_approval_kind`, and the engine has no answer to invent.
    expect(codexApprovalRequest(MCP_ELICITATION, { serverName: "linear", message: "Pick one" })).toBeNull();
  });
});

describe("a self-declared read claim is not a grant", () => {
  test("a manifest claiming a tool the host has not ratified gets nothing", () => {
    const granted = ratifiedReadTools({
      id: "latex",
      api: 1,
      name: "LaTeX",
      version: "1.0.0",
      toolPrefixes: ["latex"],
      // The plugin asks for its whole surface, including the one that compiles.
      readTools: ["latex_status", "latex_compile"],
      settings: [],
    });
    expect(granted).toEqual([]);
  });

  test("INSTALLING A HOSTILE CLAIM DOES NOT CHANGE THE ANSWER ON EITHER PROVIDER", () => {
    // The end-to-end statement: even if a plugin's ratified set were computed
    // from its own manifest, the host is what installs into the driver — and
    // `ratifiedReadTools` returns nothing for an unratified claim, so there is
    // nothing to install.
    setPluginReadTools(
      new Set(
        ratifiedReadTools({
          id: "latex",
          api: 1,
          name: "LaTeX",
          version: "1.0.0",
          toolPrefixes: ["latex"],
          readTools: ["latex_compile"],
          settings: [],
        }),
      ),
    );
    expect(claudeAsks("telar", "latex_compile")).toBe("tool_call");
    expect(codexAsks("telar", "latex_compile")?.kind).toBe("tool_call");
  });

  test("a plugin cannot borrow another plugin's ratification", () => {
    // `ds_kernel` IS in the host table — but under `data-science`, and only for
    // a plugin whose own tool namespace covers it.
    const granted = ratifiedReadTools({
      id: "latex",
      api: 1,
      name: "LaTeX",
      version: "1.0.0",
      toolPrefixes: ["latex"],
      readTools: ["ds_kernel"],
      settings: [],
    });
    expect(granted).toEqual([]);
  });
});

describe("the driver's default and the host's installation", () => {
  test("the cold default is the host table, so nothing regresses before startup", () => {
    // `requestKindForTool` is a pure module function reached from tests and from
    // both drivers with no daemon around it. Booting empty would silently turn
    // today's data-science reads into parking approval cards.
    expect(requestKindForTool("mcp__telar__ds_packages")).toBe("file_read");
  });

  test("the host can only narrow — installing an empty set removes plugin reads, not core ones", () => {
    setPluginReadTools(new Set());
    expect(requestKindForTool("mcp__telar__ds_packages")).toBe("tool_call");
    expect(requestKindForTool("mcp__telar__spool_list_items")).toBe("file_read");
  });
});
