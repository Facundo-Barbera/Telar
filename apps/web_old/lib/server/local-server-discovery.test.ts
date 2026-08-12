// @ts-expect-error -- bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { parseLocalServerListeners } from "./local-server-discovery";

describe("local server discovery", () => {
  test("extracts, sorts, and de-duplicates listening ports", () => {
    const raw = [
      "p101",
      "cnode",
      "n*:5173",
      "n[::1]:5173",
      "p102",
      "cbun dev",
      "n127.0.0.1:3000",
      "p103",
      "cpreview",
      "nlocalhost:4173 (LISTEN)",
    ].join("\n");

    expect(parseLocalServerListeners(raw)).toEqual([
      { name: "bun dev", port: 3000, url: "http://localhost:3000" },
      { name: "preview", port: 4173, url: "http://localhost:4173" },
      { name: "node", port: 5173, url: "http://localhost:5173" },
    ]);
  });

  test("ignores malformed and out-of-range listener records", () => {
    expect(parseLocalServerListeners([
      "p1",
      "cnode",
      "nlocalhost:not-a-port",
      "n*:0",
      "n*:65536",
      "n*:8080",
    ].join("\n"))).toEqual([
      { name: "node", port: 8080, url: "http://localhost:8080" },
    ]);
  });
});
