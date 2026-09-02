import { describe, expect, test } from "bun:test";
import {
  classifyServeError,
  httpsBaseUrl,
  isTailnetIpv4,
  parseStatus,
  serveArgs,
  serveOffArgs,
  serveTarget,
} from "./tailscale.mjs";
import { describeRemotePosture } from "./dev-lifecycle.mjs";

// Shaped like this machine's real `tailscale status --json`, redacted.
const STATUS_FIXTURE = JSON.stringify({
  Version: "1.102.3",
  Self: {
    DNSName: "mini-fbarbera.snakebird-cardassian.ts.net.",
    TailscaleIPs: ["100.110.136.102", "fd7a:115c:a1e0::9101:8866"],
  },
  CertDomains: null,
});

describe("tailscale status parsing", () => {
  test("trims the trailing dot and filters to CGNAT v4", () => {
    const status = parseStatus(STATUS_FIXTURE);
    expect(status.dnsName).toBe("mini-fbarbera.snakebird-cardassian.ts.net");
    expect(status.tailnetIps).toEqual(["100.110.136.102"]);
    // HTTPS certificates disabled reads as NO cert domains, never a crash.
    expect(status.certDomains).toEqual([]);
  });

  test("cert domains survive when present", () => {
    const status = parseStatus(JSON.stringify({ Self: {}, CertDomains: ["mac.tail.ts.net"] }));
    expect(status.certDomains).toEqual(["mac.tail.ts.net"]);
  });

  test("garbage degrades to empty", () => {
    expect(parseStatus("not json")).toEqual({ dnsName: null, tailnetIps: [], certDomains: [] });
  });

  test("the CGNAT range is exactly 100.64/10", () => {
    expect(isTailnetIpv4("100.64.0.1")).toBe(true);
    expect(isTailnetIpv4("100.127.255.254")).toBe(true);
    expect(isTailnetIpv4("100.63.0.1")).toBe(false);
    expect(isTailnetIpv4("100.128.0.1")).toBe(false);
  });
});

describe("serve command construction", () => {
  test("the serve target follows the bind host", () => {
    // Loopback and wildcard binds answer on 127.0.0.1; an explicit interface
    // bind answers ONLY there — proxying a tailnet-bound cockpit to loopback
    // is a silent 502.
    expect(serveTarget("127.0.0.1", 3000)).toBe("http://127.0.0.1:3000");
    expect(serveTarget("0.0.0.0", 3000)).toBe("http://127.0.0.1:3000");
    expect(serveTarget("100.110.136.102", 3000)).toBe("http://100.110.136.102:3000");
  });

  test("args are exact", () => {
    expect(serveArgs(443, "http://127.0.0.1:3000")).toEqual(["serve", "--bg", "--https=443", "http://127.0.0.1:3000"]);
    expect(serveOffArgs(443)).toEqual(["serve", "--https=443", "off"]);
  });

  test("port 443 is omitted from the https URL", () => {
    expect(httpsBaseUrl("mac.ts.net")).toBe("https://mac.ts.net");
    expect(httpsBaseUrl("mac.ts.net", 8443)).toBe("https://mac.ts.net:8443");
  });
});

describe("serve error classification", () => {
  test("labels the known failures", () => {
    expect(classifyServeError("error: HTTPS is not enabled on this tailnet", 1)).toBe("https-disabled");
    expect(classifyServeError("you are not logged in", 1)).toBe("not-logged-in");
    expect(classifyServeError("permission denied", 1)).toBe("permission-denied");
    expect(classifyServeError("handler does not exist", 1)).toBe("no-existing-handler");
  });

  test("never echoes stderr — it can carry auth keys", () => {
    const leaky = "failed: tskey-auth-kABC123CNTRL-secret was rejected";
    const label = classifyServeError(leaky, 1);
    expect(label).toBe("unknown");
    expect(leaky.includes(label)).toBe(false);
  });
});

describe("remote posture", () => {
  test("serve counts as reachability even on a loopback bind", () => {
    // The t3code bug: serve proxies the tailnet to 127.0.0.1, so inferring
    // posture from the bind host alone advertises a local-only stance on a
    // tailnet-reachable server.
    const warning = describeRemotePosture({ host: "127.0.0.1", port: 3000, serveRequested: true, requireAuth: false });
    expect(warning).toContain("remotely reachable");
    expect(warning).toContain("pairing OFF");
  });

  test("pairing retires the warning; a loopback bind without serve never earns one", () => {
    expect(describeRemotePosture({ host: "127.0.0.1", port: 3000, serveRequested: true, requireAuth: true })).toBeNull();
    expect(describeRemotePosture({ host: "100.110.136.102", port: 3000, requireAuth: true })).toBeNull();
    expect(describeRemotePosture({ host: "127.0.0.1", port: 3000 })).toBeNull();
    expect(describeRemotePosture({ host: "100.110.136.102", port: 3000 })).toContain("100.110.136.102:3000");
  });
});
