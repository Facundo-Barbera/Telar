/**
 * WHO MAY RUN WHAT, PINNED PER PROVIDER — including the places where this
 * change ALTERED behaviour rather than merely preserving it.
 *
 * Two things needed pinning and neither was covered before:
 *
 *   1. Codex's approval arm used to answer `tool_call` for EVERY MCP tool. It
 *      now runs the engine's own classifier, so a ratified read auto-accepts
 *      there as it always did on Claude. That is a REAL CHANGE to Codex's
 *      behaviour — a widening for reads — made deliberately to end a split where
 *      one tool had two authorities depending on which provider called it. It is
 *      asserted here rather than described.
 *   2. The ratified set is a MODULE GLOBAL, and the out-of-process worker is a
 *      different process from the daemon that installs it. An uninstalled
 *      process must fail CLOSED: everything asks.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { canonicalToolName, TELAR_MCP_SERVER } from "@telar/engine-client";
import { codexApprovalRequest, MCP_ELICITATION } from "../src/codex/items";
import { requestKindForTool, setPluginReadTools } from "../src/driver";
import { HOST_RATIFIED_READ_TOOLS, ratifiedReadTools } from "../src/plugins/policy";
import { latexMeta } from "../src/plugins/latex";

/** What the daemon installs after the host ratifies. */
const installed = Object.values(HOST_RATIFIED_READ_TOOLS).flat();

beforeEach(() => setPluginReadTools(installed));
afterEach(() => setPluginReadTools([]));

/** How Claude asks: a qualified name, classified directly. */
const claude = (tool: string) => requestKindForTool(canonicalToolName(TELAR_MCP_SERVER, tool));

/** How Codex asks: an elicitation whose tool name lives only in the prose. */
const codex = (tool: string) =>
  codexApprovalRequest(MCP_ELICITATION, {
    serverName: TELAR_MCP_SERVER,
    message: `Allow the telar MCP server to run tool "${tool}"?`,
    _meta: { codex_approval_kind: "mcp_tool_call", tool_params: {} },
  })?.kind;

test("a ratified plugin read auto-accepts on BOTH providers — this is the Codex change, stated", () => {
  // BEFORE: Claude `file_read`, Codex `tool_call`. One tool, two authorities.
  // AFTER: both `file_read`. Codex is the side that moved, and it moved toward
  // the classification the engine already applied everywhere else.
  for (const tool of ["ds_packages", "ds_kernel"]) {
    expect(claude(tool)).toBe("file_read");
    expect(codex(tool)).toBe("file_read");
  }
});

test("a plugin WRITE still parks a card on both providers", () => {
  // The widening is reads only. Anything that acts still asks, on either wire.
  for (const tool of ["ds_execute", "latex_compile", "latex_install"]) {
    expect(claude(tool)).toBe("tool_call");
    expect(codex(tool)).toBe("tool_call");
  }
});

test("a core read auto-accepts on both providers", () => {
  expect(claude("display_open")).toBe("file_read");
  expect(codex("display_open")).toBe("file_read");
});

test("an UNINSTALLED process fails CLOSED — every plugin tool asks", () => {
  // The process-boundary case. A worker that never installed the host's answer
  // must not treat anything as a read; asking too often is recoverable, running
  // something unapproved is not.
  setPluginReadTools([]);
  expect(claude("ds_packages")).toBe("tool_call");
  expect(codex("ds_packages")).toBe("tool_call");
  // …while core reads are unaffected, because they were never the host's to
  // ratify.
  expect(claude("display_open")).toBe("file_read");
});

test("the host can only NARROW — installing a smaller set removes plugin reads", () => {
  setPluginReadTools(["ds_packages"]);
  expect(claude("ds_packages")).toBe("file_read");
  expect(claude("ds_kernel")).toBe("tool_call");
  expect(codex("ds_kernel")).toBe("tool_call");
});

test("a manifest cannot promote its own tool — the host's table is the authority", () => {
  // LaTeX's manifest claims nothing, and the host has ratified nothing for it,
  // so every `latex_*` tool asks. A manifest that CLAIMED them would still get
  // this answer: `ratifiedReadTools` intersects the claim with the host table.
  expect(ratifiedReadTools(latexMeta)).toEqual([]);
  const claiming = { ...latexMeta, readTools: ["latex_status", "latex_log"] };
  expect(ratifiedReadTools(claiming)).toEqual([]);
  expect(claude("latex_status")).toBe("tool_call");
  expect(codex("latex_status")).toBe("tool_call");
});

test("a plugin may only be believed about its OWN namespace", () => {
  // Without the namespace guard a plugin owning `hello` could claim `ds_kernel`
  // — a name the host HAS ratified, just for somebody else — and the
  // intersection alone would let it through.
  const impostor = { ...latexMeta, id: "hello", toolPrefixes: ["hello"], readTools: ["ds_kernel"] };
  expect(ratifiedReadTools(impostor)).toEqual([]);
});

test("a user-configured server does not inherit Telar's posture", () => {
  // Only OUR servers' tools qualify. A third-party server that happened to name
  // a tool `display_open` must still ask.
  expect(requestKindForTool(canonicalToolName("someone-elses", "display_open"))).toBe("tool_call");
});
