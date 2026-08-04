import { describe, expect, test } from "bun:test";
import {
  CONTROL_PLANE_DENIAL,
  makeUltraChildGuard,
  reachesControlPlane,
  ultraChildGuard,
} from "../src/ultra/child-guard";

// THE HOLE THIS CLOSES. Ultra children cannot call `mcp__ultra__*` or
// `mcp__loom__*` — runner.ts gives them `mcpServers: {}` / only `out`. But they
// hold Bash, and Telar's own HTTP control plane is unauthenticated:
// `POST /api/looms/<id>/accept` takes no token and stamps the acceptance as the
// human. So the tool surface refused what the transport handed over.
//
// A MITIGATION, NOT A BOUNDARY, and the tests say so by what they DON'T claim:
// nothing here asserts that a determined agent cannot get out. The durable fix
// is authenticating the control plane.

describe("Ultra child guard — the control-plane rule", () => {
  test("denies curling the loom ACCEPT route — the moat's own commit action", () => {
    expect(
      reachesControlPlane('curl -X POST http://localhost:3000/api/looms/lm_123/accept'),
    ).toBe(true);
  });

  test("denies it whatever host it is spelled with", () => {
    // The rule matches the ROUTE, never the host, so loopback, the LAN address
    // and the tailnet name are one case rather than three (the dev server binds
    // *:3000 and next.config.ts carries allowedDevOrigins, so all three are
    // genuinely reachable).
    for (const host of [
      "127.0.0.1:3000",
      "localhost:3000",
      "192.168.86.20:3000",
      "mini-fbarbera.tail-scale.ts.net",
    ]) {
      expect(reachesControlPlane(`curl -X POST http://${host}/api/looms/x/accept`)).toBe(true);
    }
  });

  test("denies launching another run, and dispatching a turn", () => {
    expect(reachesControlPlane("curl -sX POST localhost:3000/api/ultra -d '{}'")).toBe(true);
    expect(reachesControlPlane("wget --post-data='{}' http://localhost:3000/api/chat")).toBe(true);
  });

  test("denies an inline script doing the same thing without a client binary", () => {
    expect(
      reachesControlPlane(`node -e 'fetch("http://localhost:3000/api/looms/x/accept",{method:"POST"})'`),
    ).toBe(true);
    expect(
      reachesControlPlane(`python3 -c "import urllib.request as u; u.urlopen('http://127.0.0.1:3000/api/ultra')"`),
    ).toBe(true);
  });

  // THE FALSE POSITIVE THAT WOULD MAKE THIS RULE UNSHIPPABLE. Ultra runs on
  // THIS repo, and this repo contains the very routes the rule names. A child
  // asked to survey the API surface must be able to grep for them — the whole
  // exploration workload does exactly this. Matching a control-plane path ALONE
  // would deny ordinary, correct work, which is why the rule requires a network
  // CLIENT (or an inline request call) as well.
  test("ALLOWS ordinary repo work that merely NAMES a control-plane path", () => {
    for (const command of [
      'grep -rn "/api/ultra" apps/web',
      "ls apps/web/app/api/looms",
      "cat apps/web/app/api/looms/\\[id\\]/accept/route.ts",
      "rg --files apps/web/app/api/chat",
      "git log --oneline -- apps/web/app/api/ultra",
    ]) {
      expect(reachesControlPlane(command)).toBe(false);
    }
  });

  test("ALLOWS ordinary network and build work that is not the control plane", () => {
    for (const command of [
      "curl -sS https://registry.npmjs.org/next",
      "bun test packages/core/test",
      "node build.js",
      "bun run --cwd apps/web build",
    ]) {
      expect(reachesControlPlane(command)).toBe(false);
    }
  });
});

describe("Ultra child guard — the hook contract", () => {
  const preToolUse = (tool: string, input: Record<string, unknown>) => ({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
  });

  test("denies with an explanation that says where the action DOES belong", async () => {
    const out = await ultraChildGuard(
      preToolUse("Bash", { command: "curl -X POST localhost:3000/api/looms/x/accept" }),
    );
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBe(CONTROL_PLANE_DENIAL);
    // `continue: true` even on a deny — the hook refuses THIS call, it does not
    // tear the child down. A killed child would surface as a dead-agent null and
    // read as a flaky run rather than as a refusal.
    expect(out.continue).toBe(true);
  });

  test("BASH IS NOT TAKEN AWAY — an ordinary command passes untouched", async () => {
    const out = await ultraChildGuard(preToolUse("Bash", { command: "bun test packages/core" }));
    expect(out.hookSpecificOutput).toBeUndefined();
    expect(out.continue).toBe(true);
  });

  test("the editing toolset is untouched — Ultra is for changing code, not only reading it", async () => {
    for (const tool of ["Write", "Edit", "Read", "Grep", "Glob"]) {
      const out = await ultraChildGuard(preToolUse(tool, { file_path: "apps/web/app/api/ultra/route.ts" }));
      expect(out.hookSpecificOutput).toBeUndefined();
    }
  });

  test("a non-PreToolUse event is passed through", async () => {
    const out = await ultraChildGuard({ hook_event_name: "PostToolUse", tool_name: "Bash" });
    expect(out).toEqual({ continue: true });
  });

  test("a Bash call with no command string is not a crash", async () => {
    expect(await ultraChildGuard(preToolUse("Bash", {}))).toEqual({ continue: true });
  });
});

// THE SECOND HALF OF THE POSTURE. A session turn has always enforced the
// project's protectedPaths/disallowedTools; a child agent enforced NEITHER,
// because makeGuardrailDecision lived in apps/web and the code that spawns lives
// in core. So `protectedPaths: [".env"]` was a session-only promise and an Ultra
// child could rewrite the very file the project declared off limits.
describe("Ultra child guard — the PROJECT's guardrails reach the child", () => {
  const root = "/tmp/telar-guard-fixture";
  const guard = makeUltraChildGuard({
    root,
    guardrails: { disallowedTools: ["WebFetch"], protectedPaths: [".env", "infra/"] },
  });
  const preToolUse = (tool: string, input: Record<string, unknown>) => ({
    hook_event_name: "PreToolUse",
    tool_name: tool,
    tool_input: input,
  });

  test("a WRITE to a protected path is denied, naming the path", async () => {
    const out = await guard(preToolUse("Write", { file_path: ".env" }));
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("protected path");
  });

  test("a protected DIRECTORY covers what is inside it", async () => {
    const out = await guard(preToolUse("Edit", { file_path: "infra/deploy.tf" }));
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("BASH reaching a protected path is denied — the target lives in `command`", async () => {
    // The check that makes protectedPaths real for the most powerful tool:
    // path-shaped input keys are empty for Bash, so without the command-word
    // scan `rm -rf .env` would sail through.
    const out = await guard(preToolUse("Bash", { command: "rm -rf .env" }));
    expect(out.hookSpecificOutput?.permissionDecision).toBe("deny");
  });

  test("a disallowed TOOL is denied by name", async () => {
    const out = await guard(preToolUse("WebFetch", { url: "https://example.com" }));
    expect(out.hookSpecificOutput?.permissionDecisionReason).toContain("disallowed");
  });

  test("ordinary editing elsewhere in the project is untouched", async () => {
    for (const input of [
      { file_path: "packages/core/src/ultra/runner.ts" },
      { file_path: "apps/web/lib/permissions.ts" },
    ]) {
      expect((await guard(preToolUse("Write", input))).hookSpecificOutput).toBeUndefined();
    }
    expect(
      (await guard(preToolUse("Bash", { command: "bun test packages/core" }))).hookSpecificOutput,
    ).toBeUndefined();
  });

  test("BOTH rules are live on one guard — the control-plane rule still fires", async () => {
    // Composition, not replacement: a guard built WITH project context must
    // still refuse the control plane, or wiring guardrails in would have
    // silently removed the rule the previous block pins.
    const out = await guard(
      preToolUse("Bash", { command: "curl -X POST localhost:3000/api/looms/x/accept" }),
    );
    expect(out.hookSpecificOutput?.permissionDecisionReason).toBe(CONTROL_PLANE_DENIAL);
  });

  test("a project with EMPTY guardrails denies nothing extra", async () => {
    // telar.yaml's own defaults are empty lists, so this is the common case and
    // it must cost nothing: no denials beyond the control-plane rule.
    const open = makeUltraChildGuard({
      root,
      guardrails: { disallowedTools: [], protectedPaths: [] },
    });
    expect((await open(preToolUse("Write", { file_path: ".env" }))).hookSpecificOutput).toBeUndefined();
    expect((await open(preToolUse("Bash", { command: "rm -rf .env" }))).hookSpecificOutput).toBeUndefined();
  });
});
