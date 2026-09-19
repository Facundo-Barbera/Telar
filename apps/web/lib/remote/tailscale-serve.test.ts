// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  // Same contract-across-two-languages problem as host-header.test.js: the
  // shell classifies in CommonJS, this types the union in TypeScript, and a
  // label added on one side is not a type error on the other — it is the pane
  // silently saying "unknown" about something we could have explained.
  test("every label tailscale.js can return is in this union", () => {
    // `fileURLToPath`, not `.pathname` — a repo under "Application Support"
    // percent-encodes its space, and the decoded path is the one fs takes.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, "..", "..", "..", "desktop", "tailscale.js"), "utf8");
    const returned = [...source.matchAll(/return "([a-z-]+)"/g)].map((match) => match[1]!);
    const classified = returned.filter((label) => label !== "none");
    expect(classified.length).toBeGreaterThan(0);
    for (const label of classified) {
      expect(describeServeError(label as TailscaleServeError)).toBeString();
    }
  });
});
