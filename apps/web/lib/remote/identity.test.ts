// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { cleanDeclared, cleanKind, describeDevice, isKnownDeviceKind, sniffUserAgent } from "./identity";

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
const SAFARI_IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

describe("declared strings", () => {
  test("control characters become spaces rather than vanishing", () => {
    // "ab" must read as two words, not silently become one.
    expect(cleanDeclared("a\u0000b")).toBe("a b");
    expect(cleanDeclared("  spaced \n out  ")).toBe("spaced out");
  });

  test("bounded, because this lands in a settings row", () => {
    expect(cleanDeclared("x".repeat(500))!.length).toBe(64);
    expect(cleanDeclared("x".repeat(500), 10)!.length).toBe(10);
  });

  test("nothing worth showing reads as absent", () => {
    expect(cleanDeclared("")).toBeUndefined();
    expect(cleanDeclared("   ")).toBeUndefined();
    expect(cleanDeclared(undefined)).toBeUndefined();
    expect(cleanDeclared(42)).toBeUndefined();
  });
});

describe("sniffing a user agent", () => {
  test("a desktop browser", () => {
    expect(sniffUserAgent(CHROME_MAC)).toEqual({ kind: "browser", client: "Chrome", os: "macOS" });
  });

  test("a phone is a phone, not a browser", () => {
    expect(sniffUserAgent(SAFARI_IPHONE)).toEqual({ kind: "phone", client: "Safari", os: "iOS" });
  });

  test("Chromium browsers all claim Chrome, so order decides", () => {
    expect(sniffUserAgent(CHROME_MAC.replace("Chrome/120.0", "Chrome/120.0 Edg/120.0")).client).toBe("Edge");
  });

  test("an app shell is a desktop app, not a fourth tab of Chrome", () => {
    const electron =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Telar/0.4.0 Chrome/126.0 Electron/31.0 Safari/537.36";
    expect(sniffUserAgent(electron)).toEqual({ kind: "desktop", client: "Telar", os: "macOS" });
  });

  test("something that is not a browser stays unknown rather than being guessed", () => {
    // A CLI has no business being labelled a browser because it sent no header.
    expect(sniffUserAgent(null)).toEqual({ kind: "unknown" });
    expect(sniffUserAgent("telar-cli/0.4").kind).toBe("unknown");
  });
});

describe("what the row says", () => {
  test("a declared name wins over everything", () => {
    expect(describeDevice({ kind: "browser", client: "Chrome" }, "Work laptop")).toBe("Work laptop");
  });

  test("otherwise it is assembled from what is known", () => {
    expect(describeDevice({ kind: "browser", client: "Firefox", os: "Linux" })).toBe("Firefox · Linux");
    expect(describeDevice({ kind: "cli", client: "telar-cli", machine: "bastion" })).toBe("telar-cli · bastion");
  });

  test("a device that said nothing is still named", () => {
    // It has to be recognisable enough to revoke.
    expect(describeDevice({ kind: "unknown" })).toBe("Unknown device");
    expect(describeDevice({ kind: "cli" })).toBe("Cli");
  });

  test("a client that declared only a kind is still named by it", () => {
    // The whole point of opening the kind: "Lintel" must survive to the row.
    expect(describeDevice({ kind: "lintel", machine: "mini-fbarbera" })).toBe("Lintel · mini-fbarbera");
    expect(describeDevice({ kind: "lintel" })).toBe("Lintel");
  });
});

describe("kinds a client declares", () => {
  test("any slug is accepted — the list is for icons, not for permission", () => {
    expect(cleanKind("Lintel")).toBe("lintel");
    expect(cleanKind("Smart TV")).toBe("smart-tv");
    expect(cleanKind("  --weird--  ")).toBe("weird");
    expect(isKnownDeviceKind("lintel")).toBe(false);
    expect(isKnownDeviceKind("cli")).toBe(true);
  });

  test("bounded and refusable, like every other declared field", () => {
    expect(cleanKind("x".repeat(80))!.length).toBe(32);
    expect(cleanKind("!!!")).toBeUndefined();
    expect(cleanKind("")).toBeUndefined();
    expect(cleanKind(7)).toBeUndefined();
  });
});
