import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describeServeError, readServeError, TAILSCALE_SERVE_ERROR_ENV, type TailscaleServeError } from "./tailscale-serve";

describe("reading the label the shell reported", () => {
  test("absent means nothing to say", () => {
    expect(readServeError({})).toBeUndefined();
    expect(readServeError({ [TAILSCALE_SERVE_ERROR_ENV]: "" })).toBeUndefined();
    expect(readServeError({ [TAILSCALE_SERVE_ERROR_ENV]: "   " })).toBeUndefined();
  });

  test("a known label reads back as itself", () => {
    expect(readServeError({ [TAILSCALE_SERVE_ERROR_ENV]: "https-disabled" })).toBe("https-disabled");
    expect(readServeError({ [TAILSCALE_SERVE_ERROR_ENV]: " not-logged-in " })).toBe("not-logged-in");
  });

  // An older shell, or a classification added on the other side of the
  // boundary: still a failure, and dropping it would put the pane back where
  // it started — "publishes at the next launch", for ever.
  test("an unrecognised label degrades to unknown, never to silence", () => {
    expect(readServeError({ [TAILSCALE_SERVE_ERROR_ENV]: "something-new" })).toBe("unknown");
  });
});

describe("every label says what to do about it", () => {
  const labels: TailscaleServeError[] = [
    "no-cert-domain",
    "https-disabled",
    "not-installed",
    "not-logged-in",
    "permission-denied",
    "unknown",
  ];

  test("each explanation is a sentence, not a code", () => {
    for (const label of labels) {
      const text = describeServeError(label);
      expect(text.length).toBeGreaterThan(30);
      expect(text).not.toContain(label);
    }
  });

  // RAW STDERR MUST NEVER REACH A USER: it can carry `tskey-…` auth keys, which
  // is why the shell crosses this boundary with a bare enum word. Nothing here
  // should ever quote the tool.
  test("no explanation quotes tailscale's output", () => {
    for (const label of labels) expect(describeServeError(label)).not.toMatch(/tskey-|stderr/i);
  });
});

describe("the shell and the pane name the same failures", () => {
  test("every failure the shell reports reaches the pane as a label it explains", async () => {
    const shell = await import("../../../../desktop/src/main/tailscale.js");
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), "telar-tailscale-bin-"));
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-tailscale-home-"));
    fs.mkdirSync(path.join(home, "remote"));
    fs.writeFileSync(path.join(home, "remote", "remote.json"), JSON.stringify({ version: 1, requireAuth: true, exposure: "network-accessible", tailscaleServe: true, devices: [] }));
    const fake = (status: string, serveStderr: string) =>
      fs.writeFileSync(path.join(bin, "tailscale"), `#!/bin/sh\nif [ "$1" = status ]; then echo '${status}'; exit 0; fi\necho '${serveStderr}' >&2\nexit 1\n`, { mode: 0o755 });
    const domain = JSON.stringify({ CertDomains: ["mac.tailnet.ts.net"] });
    const scenarios: [string, () => void][] = [
      ["no-cert-domain", () => fake("{}", "")],
      ["https-disabled", () => fake(domain, "HTTPS is not enabled for this tailnet")],
      ["not-logged-in", () => fake(domain, "You are logged out")],
      ["permission-denied", () => fake(domain, "permission denied")],
      ["unknown", () => fake(domain, "something new")],
      ["not-installed", () => fs.writeFileSync(path.join(bin, "tailscale"), `#!/bin/sh\necho '${domain}'\n/bin/rm "$0"\n`, { mode: 0o755 })],
    ];
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      for (const [expected, arrange] of scenarios) {
        arrange();
        await shell.publishTailscaleServe(home, 42731);
        const label = readServeError(shell.serveEnv());
        expect({ expected, label }).toEqual({ expected, label: expected as TailscaleServeError });
        expect(describeServeError(label!)).toBeString();
      }
    } finally {
      process.env.PATH = savedPath;
      fs.rmSync(bin, { recursive: true, force: true });
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
