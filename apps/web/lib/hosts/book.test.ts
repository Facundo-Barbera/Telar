// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { defaultHostName, normalizeBaseUrl, parsePairingUrl, recordDaemonId, removeHost, renameHost, upsertHost, type Host } from "./book";

let counter = 0;
const mint = () => `host_${++counter}`;

describe("normalizeBaseUrl", () => {
  test("one Mac, however it is spelled", () => {
    expect(normalizeBaseUrl("HTTP://Mini.Tail:3000/")).toBe("http://mini.tail:3000");
    expect(normalizeBaseUrl("http://mini.tail:3000/pair")).toBe("http://mini.tail:3000");
    expect(normalizeBaseUrl("https://mini.tail")).toBe("https://mini.tail:443");
  });

  test("refuses anything that is not an http origin", () => {
    expect(normalizeBaseUrl("ftp://mini")).toBeUndefined();
    expect(normalizeBaseUrl("mini:3000")).toBeUndefined();
    expect(normalizeBaseUrl("")).toBeUndefined();
  });
});

describe("defaultHostName", () => {
  test("the host, and the port only when it is not the default", () => {
    expect(defaultHostName("http://mini.tail:3000")).toBe("mini.tail:3000");
    expect(defaultHostName("https://mini.tail:443")).toBe("mini.tail");
  });
});

describe("parsePairingUrl", () => {
  // The link the Remote access card mints today: the eight-digit code.
  test("the cockpit's own pairing link — code in the fragment, /pair stripped", () => {
    expect(parsePairingUrl(" http://192.168.1.9:3000/pair#token=48129037 ")).toEqual({
      baseUrl: "http://192.168.1.9:3000",
      token: "48129037",
    });
  });

  test("an older cockpit's tlr_ token still rides", () => {
    expect(parsePairingUrl("http://192.168.1.9:3000/pair#token=tlr_abcDEF-_12")).toEqual({
      baseUrl: "http://192.168.1.9:3000",
      token: "tlr_abcDEF-_12",
    });
  });

  // A token in the query would reach a server log; the same refusal iOS makes.
  test("a token in the query string is refused", () => {
    expect(parsePairingUrl("http://mini:3000/pair?token=tlr_abc")).toBeUndefined();
  });

  test("not a pairing link at all", () => {
    expect(parsePairingUrl("http://mini:3000/")).toBeUndefined();
    expect(parsePairingUrl("http://mini:3000/pair#token=nope")).toBeUndefined();
    expect(parsePairingUrl("http://mini:3000/pair#token=1234567")).toBeUndefined();
    expect(parsePairingUrl("http://mini:3000/pair#token=123456789")).toBeUndefined();
    expect(parsePairingUrl("garbage")).toBeUndefined();
  });
});

describe("upsertHost", () => {
  test("adds with a minted id and the address as its name", () => {
    const { hosts, result } = upsertHost([], { baseUrl: "http://mini:3000/", deviceToken: "tlr_a" }, 10, mint);
    expect(result.kind).toBe("added");
    expect(hosts[0]).toMatchObject({ baseUrl: "http://mini:3000", name: "mini:3000", deviceToken: "tlr_a", addedAt: 10 });
  });

  test("a re-pair of a known address keeps the id and takes the new token", () => {
    const first = upsertHost([], { baseUrl: "http://mini:3000", deviceToken: "tlr_a", name: "Mini" }, 10, mint);
    const again = upsertHost(first.hosts, { baseUrl: "HTTP://MINI:3000/", deviceToken: "tlr_b" }, 20, mint);
    expect(again.result.kind).toBe("replaced");
    expect(again.hosts).toHaveLength(1);
    expect(again.hosts[0]).toMatchObject({ id: first.hosts[0]!.id, name: "Mini", deviceToken: "tlr_b", addedAt: 10 });
  });
});

describe("recordDaemonId", () => {
  const two = (): Host[] => [
    { id: "old", name: "Mini", baseUrl: "http://mini:3000", deviceToken: "tlr_a", addedAt: 10, daemonId: "d1" },
    { id: "new", name: "Mini via tailnet", baseUrl: "http://mini.tail:3000", deviceToken: "tlr_b", addedAt: 20 },
  ];

  test("learns the id on a lone record", () => {
    const { hosts, merged } = recordDaemonId(two().slice(1), "new", "d9");
    expect(merged).toBe(false);
    expect(hosts[0]).toMatchObject({ id: "new", daemonId: "d9" });
  });

  // Same Mac added twice under two addresses: the OLDER row owns everything
  // keyed on its id, the newer address is the one that works right now.
  test("merges a twin into the older record and keeps the newer address", () => {
    const { hosts, merged } = recordDaemonId(two(), "new", "d1");
    expect(merged).toBe(true);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toMatchObject({ id: "old", baseUrl: "http://mini.tail:3000", deviceToken: "tlr_b", daemonId: "d1" });
  });
});

describe("rename and remove", () => {
  const one: Host[] = [{ id: "h", name: "Mini", baseUrl: "http://mini:3000", deviceToken: "tlr_a", addedAt: 1 }];
  test("an empty rename falls back to the address rather than a blank row", () => {
    expect(renameHost(one, "h", "  ")[0]!.name).toBe("mini:3000");
    expect(renameHost(one, "h", " Studio ")[0]!.name).toBe("Studio");
  });
  test("remove", () => {
    expect(removeHost(one, "h")).toEqual([]);
    expect(removeHost(one, "x")).toEqual(one);
  });
});
