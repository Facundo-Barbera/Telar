// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComputerUseStatus } from "@telar/engine-client";
import { ComputerUseProviders, computerUseHint, computerUseState, PermissionsSection } from "./permissions-section";

const probe = (over: Partial<ComputerUseStatus> = {}) =>
  ({ installed: true, hostRunning: true, backend: "cua", permission: "granted", ...over }) as unknown as ComputerUseStatus;

/**
 * The Agent tools pane's states, and the one that was lying.
 *
 * The readout is a pure function, so every branch is testable without a
 * network; the structural claims are read from source, because these components
 * fetch on mount and what is being pinned is the COPY and the branch structure.
 */
const permissions = readFileSync(new URL("./permissions-section.tsx", import.meta.url), "utf8");
const mcp = readFileSync(new URL("./mcp-section.tsx", import.meta.url), "utf8");
const logins = readFileSync(new URL("./browser-logins-section.tsx", import.meta.url), "utf8");
const orientation = readFileSync(new URL("./orientation-section.tsx", import.meta.url), "utf8");
const pane = readFileSync(new URL("./settings-page.tsx", import.meta.url), "utf8");

test("the probe states each say something different, and a failure is not 'checking'", () => {
  // The regression this pins: once the request rejected, `checking` went false
  // and `status` stayed undefined, so a `!status` branch said "Checking" forever.
  expect(computerUseState({ checking: true, failed: false })).toBe("checking");
  expect(computerUseState({ checking: false, failed: true })).toBe("unknown");
  expect(computerUseHint("unknown")).toContain("Could not reach the engine");
  // Neither may name an engine before one has been measured.
  for (const state of ["checking", "unknown"] as const) {
    expect(computerUseHint(state) ?? "").not.toContain("cua-driver");
  }
});

test("three rows became one readout, ordered by what stops the feature first", () => {
  // Engine / Driver daemon / Access were three badges a reader had to combine
  // to answer one question (#357). An engine that is not installed cannot be
  // ungranted, and one that is not running cannot be tested.
  expect(computerUseState({ status: probe(), checking: false, failed: false })).toBe("ready");
  expect(computerUseState({ status: probe({ permission: "denied" }), checking: false, failed: false })).toBe("not-granted");
  expect(computerUseState({ status: probe({ permission: "unauthenticated" }), checking: false, failed: false })).toBe("not-accepted");
  expect(computerUseState({ status: probe({ hostRunning: false, permission: "denied" }), checking: false, failed: false })).toBe("not-running");
  expect(computerUseState({ status: probe({ installed: false, hostRunning: false }), checking: false, failed: false })).toBe("not-installed");
});

test("a working setup says so with its badge and no sentence at all", () => {
  // "Open source — Telar holds the grants through CuaDriver.app" was an
  // implementation note printed at every reader who had nothing to fix.
  expect(computerUseHint("ready")).toBeUndefined();
  expect(permissions).not.toContain("Open source");
  expect(permissions).not.toContain("Codex's bundled client");
  expect(permissions).not.toContain("Launches automatically when a session first needs it");
});

test("the security semantics survive the copy edit", () => {
  // Compacting must not drop what a person needs to act: which grants are
  // required, and what to install.
  expect(computerUseHint("not-granted")).toContain("Accessibility + Screen Recording");
  expect(computerUseHint("not-installed")).toContain("Install cua-driver");
  expect(logins).toContain("Telar asks before every fill");
});

test("a client that refuses Telar as its caller is 'Not accepted', not a grant to go find", () => {
  // Sky answered "-10000: Sender process is not authenticated" to every call
  // from Telar, and the row sent readers to an Automation pane that could not
  // fix it. The refusal is its own state now, and the Sky fallback is gone.
  const hint = computerUseHint("not-accepted") ?? "";
  expect(hint).toContain("does not accept Telar");
  expect(hint).not.toContain("Automation");
  expect(computerUseHint("not-installed")).not.toContain("Codex");
  expect(permissions).toContain('"Not accepted"');
  expect(permissions).not.toContain("Privacy & Security → Automation");
  expect(permissions).not.toContain("AUTOMATION_PANE");
  expect(permissions).not.toContain("wakeComputerUseHost");
});

test("the row says the probe is the gate, behind its ⓘ", () => {
  expect(permissions).toContain('info="Sessions get the desktop tools only after a check here answers Ready."');
});

test("the Computer use row says WHOSE sessions it governs, in one line", () => {
  /**
   * #368. The row measured a macOS grant and named no provider, which reads as
   * "all of them". Since #521 every provider Telar drives does get this
   * desktop, so "all of them" is now TRUE — the row names them anyway, because
   * a reader cannot tell a silent promise from a silent assumption, and this
   * row has already been wrong in both directions.
   */
  const html = renderToStaticMarkup(<ComputerUseProviders />);
  expect(html).toContain("Claude");
  expect(html).toContain("Codex");
  expect(html).toContain("OpenCode");
  // Nobody is on the "uses its own" side today. Asserted as absent rather than
  // dropped: that half must reappear the moment a provider stops taking ours.
  expect(html).not.toContain("uses its own");
  // The engine's own list decides — not a hand-kept copy that can drift from
  // what a claim actually folds in.
  expect(permissions).toContain("driverTakesComputerUse");
  // It rides the row rather than the hint: the hint is the sentence that
  // changes with the state, and a working setup still has none.
  expect(computerUseHint("ready")).toBeUndefined();
  expect(permissions).toContain("<ComputerUseProviders />");
});

test("the FAILED state renders Unknown with a Retry, never a spinner", () => {
  const html = renderToStaticMarkup(<PermissionsSection />);
  // First paint, before the probe lands: a spinner, and no claim about a grant.
  expect(html).not.toContain("Not granted");
  expect(permissions).toContain('state === "unknown" && (');
  expect(permissions).toContain("Retry");
});

test("the empty server list does not repeat itself in a pill", () => {
  const empty = mcp.slice(mcp.indexOf('label="No servers configured"'));
  expect(empty.slice(0, 200)).not.toContain('<Badge variant="outline">None</Badge>');
});

test("Add is the list's own header button, not a card whose row is a button", () => {
  // It used to be a whole SettingsGroup titled "Add a server" holding one row
  // whose entire content was an Add button (#357) — the shape Browser profiles
  // already avoids with "New profile" on the group header.
  expect(mcp).toContain("const [adding, setAdding] = useState(false)");
  expect(mcp).toContain("onClick={() => setAdding(true)}");
  expect(mcp).toContain("{adding && <AddServerForm");
  expect(mcp).not.toContain('label="Add a server"');
});

test("adding is progressive, and closes once one lands", () => {
  // The pane used to lead with an empty three-transport form instead of with
  // what is configured. Opening is reversible, and success returns to the list.
  expect(mcp).toContain("Cancel");
  const save = mcp.slice(mcp.indexOf("onAdded();"));
  expect(save.slice(0, 200)).toContain("onClose();");
});

test("remembered logins' empty state is a row on the same grid, not a loose paragraph", () => {
  expect(logins).toContain('<Row label="No remembered logins"');
  expect(logins).not.toContain("None. Telar asks before every credential fill");
});

test("orientation leads the pane, because it is what Telar does before you have said anything", () => {
  // The two groups under it decide what an agent may REACH; this decides what
  // it is TOLD, which is the first thing somebody auditing Telar looks for.
  const tools = pane.slice(pane.indexOf('active === "tools"'));
  expect(tools.indexOf("<OrientationSection />")).toBeLessThan(tools.indexOf("<McpSection />"));
});

test("the disclosure shows the engine's own paragraph, never a copy kept in the cockpit", () => {
  /**
   * THE DRIFT THIS FORBIDS. A second copy of the preamble in this file would
   * be right until the first edit on the engine side — and a paired Mac may be
   * running a different release entirely, so a hard-coded paragraph could
   * disagree with what is actually injected on the machine being configured.
   */
  expect(orientation).toContain("setText(answer.text)");
  expect(orientation).toContain("{text ||");
  expect(orientation).not.toContain("You are running inside Telar");
});

test("both switches move independently, and each is one patch", () => {
  // `preamble` and `skill` are separate questions: patching one must not
  // re-decide the other, which is what a single combined write would do.
  expect(orientation).toContain("save({ preamble: next })");
  expect(orientation).toContain("save({ skill: next })");
});

test("the text stays readable with the switch off", () => {
  // "What would you inject?" is a fair question to ask BEFORE turning it back
  // on, so the disclosure is not nested under the preamble's own state.
  const disclosure = orientation.slice(orientation.indexOf("Show the text"));
  expect(disclosure).not.toContain("policy.preamble &&");
});
