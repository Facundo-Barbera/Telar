import { describe, expect, test } from "bun:test";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComputerUseStatus } from "@telar/engine-client";
import { buttonLabelled as button, click, flush, mount, press, stubFetch, installTestDom, type Route } from "@/test/dom";
import { typeInto } from "@/test/type-into";
import { BrowserLoginsSection } from "@/features/browser/panes/browser-logins-section";
import { McpSection } from "@/features/agent-tools/components/mcp-section";
import { OrientationSection } from "@/features/agent-tools/components/orientation-section";
import { ComputerUseProviders, computerUseHint, computerUseState, PermissionsSection } from "@/features/providers/components/permissions-section";
import { grantFollowUp, GRANT_POLL_MS, GRANT_WAIT_MS } from "@/features/providers/hooks/use-computer-use";

installTestDom();

const probe = (over: Partial<ComputerUseStatus> = {}) =>
  ({ installed: true, hostRunning: true, backend: "cua", permission: "granted", ...over }) as unknown as ComputerUseStatus;

let calls: { route: string; body: unknown }[] = [];
const stubEngine = (routes: Record<string, Route>) => (calls = stubFetch(routes));
const called = (route: string) => calls.filter((call) => call.route === route);

async function mountPermissions(status: () => ComputerUseStatus, routes: Record<string, Route> = {}) {
  stubEngine({ "GET /api/computer-use": () => ({ computerUse: status() }), ...routes });
  const { host } = await mount(<PermissionsSection />);
  await flush(() => called("GET /api/computer-use").length > 0 && !host.querySelector('[data-slot="spinner"]'));
  return host;
}

describe("computer use", () => {
  test("the probe states each say something different, and a failure is not 'checking'", () => {
    expect(computerUseState({ checking: true, failed: false })).toBe("checking");
    expect(computerUseState({ checking: false, failed: true })).toBe("unknown");
    expect(computerUseHint("unknown")).toContain("Could not reach the engine");
    for (const state of ["checking", "unknown"] as const) {
      expect(computerUseHint(state) ?? "").not.toContain("cua-driver");
    }
  });

  test("one readout, ordered by what stops the feature first", () => {
    expect(computerUseState({ status: probe(), checking: false, failed: false })).toBe("ready");
    expect(computerUseState({ status: probe({ permission: "denied" }), checking: false, failed: false })).toBe("not-granted");
    expect(computerUseState({ status: probe({ permission: "unauthenticated" }), checking: false, failed: false })).toBe("not-accepted");
    expect(computerUseState({ status: probe({ hostRunning: false, permission: "denied" }), checking: false, failed: false })).toBe("not-running");
    expect(computerUseState({ status: probe({ installed: false, hostRunning: false }), checking: false, failed: false })).toBe("not-installed");
  });

  test("the fix names the grants and what to install; bundled, it names Telar's helper", () => {
    expect(computerUseHint("not-granted")).toContain("Accessibility + Screen Recording");
    expect(computerUseHint("not-granted")).toContain("CuaDriver.app");
    expect(computerUseHint("not-installed")).toContain("Install cua-driver");
    expect(computerUseHint("not-installed")).not.toContain("Codex");
    const bundled = computerUseHint("not-granted", { bundled: true }) ?? "";
    expect(bundled).toContain("Accessibility + Screen Recording");
    expect(bundled).toContain("Computer Use for Telar");
    expect(bundled).not.toContain("CuaDriver.app");
    expect(bundled).not.toContain("Finder");
    expect(computerUseHint("ready", { bundled: true })).toBeUndefined();
  });

  test("a working setup says so with its badge and no sentence at all", async () => {
    const host = await mountPermissions(() => probe());
    expect(host.textContent).toContain("Ready");
    expect(computerUseHint("ready")).toBeUndefined();
    for (const gone of ["Open source", "Codex's bundled client", "Launches automatically"]) expect(host.textContent).not.toContain(gone);
    expect(button("Test access")).toBeDefined();
  });

  test("a client that refuses Telar as its caller is 'Not accepted', with no grant to go find", async () => {
    const host = await mountPermissions(() => probe({ permission: "unauthenticated" }));
    expect(host.textContent).toContain("Not accepted");
    expect(host.textContent).toContain("does not accept Telar");
    expect(host.textContent).not.toContain("Automation");
    expect(button("Grant access")).toBeUndefined();
  });

  test("the ⓘ says the probe is the gate; bundled, it adds Finder and what Remove clears", async () => {
    const plain = await mountPermissions(() => probe());
    expect(plain.querySelector("[data-info]")?.getAttribute("data-info")).toBe("Sessions get the desktop tools only after a check here answers Ready.");

    const bundled = await mountPermissions(() => probe({ bundled: true }));
    const info = bundled.querySelector("[data-info]")?.getAttribute("data-info") ?? "";
    expect(info).toStartWith("Sessions get the desktop tools only after a check here answers Ready.");
    expect(info).toContain("drag it in");
    expect(info).toContain("clears only Telar's bundled helper, not a separately installed cua");
  });

  test("Remove permissions is the bundled helper's alone, and asks first", async () => {
    await mountPermissions(() => probe());
    expect(button("Remove permissions")).toBeUndefined();

    await mountPermissions(() => probe({ bundled: true }), { "POST /api/computer-use/reset": () => ({ reset: true }) });
    await click(button("Remove permissions"));
    expect(called("POST /api/computer-use/reset")).toHaveLength(0);
    await click(button("Cancel"));
    expect(button("Confirm remove")).toBeUndefined();

    await click(button("Remove permissions"));
    const probes = called("GET /api/computer-use").length;
    await click(button("Confirm remove"));
    expect(called("POST /api/computer-use/reset")).toHaveLength(1);
    expect(called("GET /api/computer-use").length).toBe(probes + 1);
  });

  test("the row names whose sessions it governs, from the engine's own list", () => {
    const html = renderToStaticMarkup(<ComputerUseProviders />);
    for (const provider of ["Claude", "Codex", "OpenCode"]) expect(html).toContain(provider);
    // Nobody uses their own today; that half must reappear the moment a provider does.
    expect(html).not.toContain("uses its own");
  });

  test("a failed probe renders Unknown with a Retry, never a spinner", async () => {
    expect(renderToStaticMarkup(<PermissionsSection />)).not.toContain("Not granted");
    let answers = false;
    const host = await mountPermissions(() => {
      if (!answers) throw new Error("down");
      return probe();
    });
    expect(host.textContent).toContain("Unknown");
    expect(host.textContent).toContain("Could not reach the engine");
    answers = true;
    await click(button("Retry"));
    expect(host.textContent).toContain("Ready");
  });

  test("while System Settings is open the pane re-measures on focus, moves on to Screen Recording, and flips to Ready", async () => {
    expect(grantFollowUp("accessibility", probe({ permission: "denied", missing: ["accessibility", "screen-recording"] }))).toBe("wait");
    expect(grantFollowUp("screen-recording", probe({ permission: "denied", missing: ["screen-recording"] }))).toBe("wait");
    expect(grantFollowUp(undefined, probe())).toBe("done");
    expect(GRANT_POLL_MS).toBeLessThanOrEqual(5_000);
    expect(GRANT_WAIT_MS).toBe(600_000);

    let status = probe({ permission: "denied", missing: ["accessibility", "screen-recording"] });
    let opened = "accessibility";
    const host = await mountPermissions(() => status, { "POST /api/computer-use/grant": () => ({ started: true, opened }) });
    await click(button("Grant access"));
    expect(called("POST /api/computer-use/grant")).toHaveLength(1);

    status = probe({ permission: "denied", missing: ["screen-recording"] });
    opened = "screen-recording";
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(called("POST /api/computer-use/grant")).toHaveLength(2);

    status = probe();
    await act(async () => window.dispatchEvent(new Event("focus")));
    await flush();
    expect(host.textContent).toContain("Ready");
  });

  test("Grant's failures reach the row, and the bundled helper can be shown in Finder", async () => {
    const host = await mountPermissions(() => probe({ bundled: true, permission: "denied" }), {
      "POST /api/computer-use/grant": () => ({ started: false, message: "macOS refused the prompt." }),
      "POST /api/computer-use/reveal": () => ({ revealed: true }),
    });
    await click(button("Grant access"));
    expect(host.textContent).toContain("macOS refused the prompt.");
    await click(button("Show in Finder"));
    expect(called("POST /api/computer-use/reveal")).toHaveLength(1);
  });
});

describe("MCP servers", () => {
  const empty = { "GET /api/mcp-servers": () => ({ mcpServers: [] }), "GET /api/mcp/oauth": () => ({ statuses: [] }) };

  test("the empty list is one row, not a row and a pill", async () => {
    stubEngine(empty);
    const { host } = await mount(<McpSection />);
    await flush(() => Boolean(host.textContent?.includes("No servers configured")));
    expect(host.textContent).toContain("No servers configured");
    expect(host.textContent).not.toContain("None");
  });

  test("Add opens the form from the list's header, Cancel closes it, and a saved server closes it too", async () => {
    stubEngine({ ...empty, "PUT /api/mcp-servers": (body) => ({ mcpServer: body }) });
    const { host } = await mount(<McpSection />);
    await flush(() => Boolean(button("Add")));
    expect(host.textContent).not.toContain("Add a server");

    await click(button("Add"));
    expect(host.textContent).toContain("Add a server");
    expect(button("Add")).toBeUndefined();
    await click(button("Cancel"));
    expect(host.textContent).not.toContain("Add a server");

    await click(button("Add"));
    await typeInto(host.querySelector('[aria-label="Server id"]') as HTMLInputElement, "linear");
    await typeInto(host.querySelector('[aria-label="Command"]') as HTMLInputElement, "node server.js --port 9000");
    await click(button("Add server"));
    expect(called("PUT /api/mcp-servers").map((call) => call.body)).toEqual([
      { id: "linear", spec: { transport: "stdio", command: "node", args: ["server.js", "--port", "9000"] } },
    ]);
    expect(host.textContent).not.toContain("Add a server");
  });
});

test("remembered logins' empty state is a row that says Telar asks before every fill", async () => {
  stubEngine({ "GET /api/browser-logins": () => ({ logins: [] }) });
  const { host } = await mount(<BrowserLoginsSection />);
  await flush(() => Boolean(host.textContent?.includes("No remembered logins")));
  expect(host.querySelector('[id$="no-remembered-logins"]')?.textContent).toContain("Telar asks before every fill");
});

describe("Telar orientation", () => {
  const ENGINE_TEXT = "The paragraph the engine injects.";

  async function mountOrientation(orientation: { preamble: boolean; skill: boolean }, answers = true) {
    stubEngine({
      "GET /api/orientation": () => {
        if (!answers) throw new Error("down");
        return { orientation, text: ENGINE_TEXT };
      },
      "PATCH /api/orientation": (patch) => ({ orientation: { ...orientation, ...(patch as object) }, text: ENGINE_TEXT }),
    });
    const { host } = await mount(<OrientationSection />);
    await flush(() => called("GET /api/orientation").length > 0);
    await flush();
    return host;
  }

  test("the disclosure shows the engine's own paragraph, even with the switch off", async () => {
    const host = await mountOrientation({ preamble: false, skill: true });
    expect(host.textContent).not.toContain(ENGINE_TEXT);
    await click(button("Show the text"));
    expect(host.textContent).toContain(ENGINE_TEXT);
  });

  test("with no answer from the engine, the disclosure says so rather than inventing a paragraph", async () => {
    const host = await mountOrientation({ preamble: true, skill: true }, false);
    await click(button("Show the text"));
    expect(host.textContent).toContain("The engine did not answer.");
  });

  test("both switches move independently, and each is one patch", async () => {
    const host = await mountOrientation({ preamble: true, skill: true });
    await press(host.querySelector('[aria-label="Tell agents they are inside Telar"]')!);
    await press(host.querySelector('[aria-label="Install the telar skill"]')!);
    expect(called("PATCH /api/orientation").map((call) => call.body)).toEqual([{ preamble: false }, { skill: false }]);
  });
});
