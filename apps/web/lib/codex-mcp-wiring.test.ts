// THE ROSTER THE CODEX BRANCH BUILDS — story 13's wiring half.
//
// codex-mcp.test.ts proves the CONVERSION is right and codex-turn-mcp-wire.test.ts
// proves a roster reaches the wire. Neither can see the thing between them: what
// `app/api/chat/route.ts` actually puts INTO the converter. A review found that
// gap by inspection — swapping the two spreads, or accidentally including
// `telarMcpServers` (Telar's own in-process `sdk` servers, which would then be
// dropped and warned about on every single turn), ships green under both.
//
// WHY A SOURCE SCAN. The roster is built inside the route's ReadableStream,
// after a session profile is resolved and a project is anchored, with no export
// and no seam — the same constraint full-access-subagent.test.ts,
// compaction-wire.test.ts and command-keys-wiring.test.ts work under, and the
// same technique invariants.test.ts already applies to this file. What can be
// pinned is the shape of the expression and the ORDER of its parts, which is
// exactly what a refactor breaks silently.
//
// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");

// The `toCodexMcpServers({ … })` call and its argument, whitespace-collapsed:
// the formatter wraps this across lines, so matching a particular break would
// pin the formatter rather than the behaviour.
const rosterCall = (() => {
  const start = route.indexOf("const codexMcp = toCodexMcpServers({");
  expect(start).toBeGreaterThan(-1);
  const end = route.indexOf("});", start);
  expect(end).toBeGreaterThan(start);
  return route.slice(start, end).replace(/\s+/g, " ");
})();

// The Claude branch's own literal, for the equivalence rows below.
const claudeRoster = (() => {
  const start = route.indexOf("mcpServers: {");
  expect(start).toBeGreaterThan(-1);
  const end = route.indexOf("strictMcpConfig", start);
  expect(end).toBeGreaterThan(start);
  return route.slice(start, end).replace(/\s+/g, " ");
})();

describe("the Codex branch's MCP roster is built from the same two sources as Claude's", () => {
  test("both spreads are present", () => {
    expect(rosterCall).toContain("...sessionProfile.mcpServers");
    expect(rosterCall).toContain("resolveProjectMcpServers(");
  });

  test("the ORDER matches the Claude literal — profile first, project last", () => {
    // Later keys win in both. Swapping them is a real behaviour change (a
    // project's own server would be silently dropped instead of shadowing a
    // profile's), and it is invisible to every other test in this repo.
    const profileAt = rosterCall.indexOf("...sessionProfile.mcpServers");
    const projectAt = rosterCall.indexOf("resolveProjectMcpServers(");
    expect(profileAt).toBeGreaterThan(-1);
    expect(profileAt).toBeLessThan(projectAt);
    // …and the Claude literal really does order them that way, so this row is
    // an equivalence and not a restated constant.
    const cProfileAt = claudeRoster.indexOf("...sessionProfile.mcpServers");
    const cProjectAt = claudeRoster.indexOf("resolveProjectMcpServers(");
    expect(cProfileAt).toBeGreaterThan(-1);
    expect(cProfileAt).toBeLessThan(cProjectAt);
  });

  test("`telarMcpServers` is NOT in it — those travel as dynamicTools", () => {
    // Telar's own servers are in-process `sdk` objects. Including them would
    // not mount them twice; it would convert them, drop every one as
    // unconvertible, and log a warning per server — a permanent false alarm
    // about capabilities that are working fine over the other channel.
    expect(rosterCall).not.toContain("telarMcpServers");
    // Anti-vacuity: the Claude branch DOES include them, so the absence above
    // is a decision about this branch rather than a name that does not exist.
    expect(claudeRoster).toContain("...telarMcpServers");
  });

  test("the project is gated on the SAME value the branch already resolved", () => {
    // The branch spends `project ?? ""` on `codexProject` and argues at length
    // that `undefined` is unreachable. Re-asking `project ? … : {}` here would
    // be a second, contradictory answer to a question already answered.
    expect(rosterCall).toContain("codexProject ? resolveProjectMcpServers(codexProject)");
    expect(rosterCall).not.toMatch(/\bproject \? resolveProjectMcpServers\(project\)/);
  });
});

describe("what comes out of the roster is reported and then sent", () => {
  const afterRoster = route.slice(route.indexOf("const codexMcp = toCodexMcpServers({")).replace(/\s+/g, " ");

  test("the losses are warned, and scoped by project", () => {
    // Unscoped, the module-global dedupe set lets one project's dropped server
    // permanently silence another project's identically-named one.
    expect(afterRoster).toContain("warnCodexMcpLosses(codexMcp, codexProject");
  });

  test("the servers are handed to runCodexTurn, and omitted when empty", () => {
    const turnCall = afterRoster.slice(afterRoster.indexOf("runCodexTurn({"));
    expect(turnCall).toContain("Object.keys(codexMcp.servers).length ? { mcpServers: codexMcp.servers } : {}");
    // The omit-when-empty guard is the property that keeps every server-less
    // session — which is every Codex session today — sending a byte-identical
    // request. `codex-turn-mcp-wire.test.ts` pins the layer below it; this pins
    // that the route does not defeat it by passing `{}` unconditionally.
    expect(turnCall).not.toMatch(/mcpServers: codexMcp\.servers,/);
  });

  test("the warn happens BEFORE the turn starts", () => {
    // A warning emitted after the generator is drained is a warning nobody
    // reads until the turn is over.
    const warnAt = afterRoster.indexOf("warnCodexMcpLosses(");
    const turnAt = afterRoster.indexOf("runCodexTurn({");
    expect(warnAt).toBeGreaterThan(-1);
    expect(warnAt).toBeLessThan(turnAt);
  });
});
