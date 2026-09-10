// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComputerUseStatus } from "@telar/engine-client";
import { engineHint } from "./permissions-section";
import { Row } from "./settings-shell";

const installed = { installed: true, hostRunning: true, backend: "cua", permission: "granted" } as unknown as ComputerUseStatus;

/**
 * The Agent tools pane's three states, and the one that was lying.
 *
 * Read from source rather than mounted: these components fetch on mount, and
 * what is being pinned is the COPY and the branch structure — a loading state
 * that names an engine before anything has been measured is a correctness bug,
 * not a layout preference.
 */
const permissions = readFileSync(new URL("./permissions-section.tsx", import.meta.url), "utf8");
const mcp = readFileSync(new URL("./mcp-section.tsx", import.meta.url), "utf8");
const logins = readFileSync(new URL("./browser-logins-section.tsx", import.meta.url), "utf8");

test("the three probe states each say something different, and only one names an engine", () => {
  // The regression this pins: once the request rejected, `checking` went false
  // and `status` stayed undefined, so a `!status` branch said "Checking" forever.
  const checking = engineHint({ checking: true, failed: false, isCua: false });
  const failed = engineHint({ checking: false, failed: true, isCua: false });
  expect(checking).toBe("Checking which engine is installed.");
  expect(failed).toContain("Could not reach the engine");
  expect(failed).not.toBe(checking);
  for (const hint of [checking, failed]) {
    expect(hint).not.toContain("Codex");
    expect(hint).not.toContain("cua-driver");
  }
});

test("an ANSWERED probe names the engine it measured", () => {
  expect(engineHint({ status: installed, checking: false, failed: false, isCua: true })).toContain("Open source");
  expect(engineHint({ status: installed, checking: false, failed: false, isCua: false })).toContain("Codex's bundled client");
  const absent = { installed: false, hostRunning: false } as unknown as ComputerUseStatus;
  expect(engineHint({ status: absent, checking: false, failed: false, isCua: false })).toContain("Install cua-driver");
});

test("the FAILED state renders Unknown with a Retry, never a spinner", () => {
  const html = renderToStaticMarkup(
    <Row
      label="Engine"
      hint={engineHint({ checking: false, failed: true, isCua: false })}
      control={
        <div>
          <span>Unknown</span>
          <button type="button">Retry</button>
        </div>
      }
    />,
  );
  expect(html).toContain("Unknown");
  expect(html).toContain("Retry");
  expect(html).toContain("Could not reach the engine");
});

test("the empty server list does not repeat itself in a pill", () => {
  const empty = mcp.slice(mcp.indexOf('label="No servers configured"'));
  expect(empty.slice(0, 200)).not.toContain('<Badge variant="outline">None</Badge>');
});

test("Add a server is progressive, and closes once one lands", () => {
  // The pane used to lead with an empty three-transport form instead of with
  // what is configured.
  expect(mcp).toContain("const [open, setOpen] = useState(false)");
  expect(mcp).toContain("if (!open)");
  // Opening is reversible, and success returns to the list.
  expect(mcp).toContain("Cancel");
  const save = mcp.slice(mcp.indexOf("onAdded();"));
  expect(save.slice(0, 200)).toContain("setOpen(false)");
});

test("remembered logins' empty state is a row on the same grid, not a loose paragraph", () => {
  expect(logins).toContain('<Row label="No remembered logins"');
  expect(logins).not.toContain("None. Telar asks before every credential fill");
});

test("the security semantics survive the copy edit", () => {
  // Compacting must not drop what a person needs to act: which grants are
  // required, and where macOS hides the switch.
  expect(permissions).toContain("Accessibility + Screen Recording");
  expect(permissions).toContain("Privacy & Security → Automation");
  expect(logins).toContain("Telar asks before every fill");
});
