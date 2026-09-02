// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { dialledLoopback, machineName, observeIdentity, peerAddress } from "./observe";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("what the server observes", () => {
  test("the first forwarded hop, and nothing a client appended after it", () => {
    expect(peerAddress(req("http://x/", { "x-forwarded-for": "100.64.0.9, 10.0.0.1" }))).toBe("100.64.0.9");
    expect(peerAddress(req("http://x/", { "x-real-ip": "192.168.1.4" }))).toBe("192.168.1.4");
    expect(peerAddress(req("http://x/"))).toBeUndefined();
  });

  test("loopback is judged by the host it DIALLED, not by a header it sent", () => {
    // A request that arrived on 127.0.0.1 cannot have crossed a network;
    // a forwarded-for claiming loopback is just a string.
    expect(dialledLoopback(req("http://127.0.0.1:3100/api/pair"))).toBe(true);
    expect(dialledLoopback(req("http://localhost:3100/api/pair"))).toBe(true);
    expect(dialledLoopback(req("http://100.110.136.102:3100/api/pair", { "x-forwarded-for": "127.0.0.1" }))).toBe(false);
  });

  test("the machine name drops the .local nobody reads", () => {
    expect(machineName("mini-fbarbera.local")).toBe("mini-fbarbera");
    expect(machineName("bastion")).toBe("bastion");
  });
});

describe("assembling an identity", () => {
  test("a client declaring its own type keeps it", () => {
    const identity = observeIdentity(req("http://100.64.0.3:3100/api/pair", { "user-agent": CHROME_MAC }), {
      kind: "Lintel",
      client: "Lintel",
      machine: "mini-fbarbera",
    });
    expect(identity.kind).toBe("lintel");
    expect(identity.client).toBe("Lintel");
    expect(identity.machine).toBe("mini-fbarbera");
    // Sniffing still fills what was not declared.
    expect(identity.os).toBe("macOS");
  });

  test("a loopback caller gets this machine's name; a remote one never does", () => {
    expect(observeIdentity(req("http://127.0.0.1:3100/api/remote")).machine).toBe(machineName());
    expect(observeIdentity(req("http://100.64.0.3:3100/api/remote")).machine).toBeUndefined();
  });

  test("origin is recorded because pairing is per-origin", () => {
    expect(observeIdentity(req("http://100.64.0.3:3100/api/pair")).origin).toBe("100.64.0.3:3100");
  });

  test("a caller that said nothing and sent no header is unknown, not a browser", () => {
    expect(observeIdentity(req("http://100.64.0.3:3100/api/pair")).kind).toBe("unknown");
  });
});
