// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { codeFromInput, formatTyped } from "./pair-client";

describe("formatTyped", () => {
  test("digits are grouped 4+4 as they are typed; letters are left alone", () => {
    expect(formatTyped("4812")).toBe("4812");
    expect(formatTyped("48129")).toBe("4812 9");
    expect(formatTyped("4812 9037")).toBe("4812 9037");
    expect(formatTyped("4812-9037")).toBe("4812 9037");
    expect(formatTyped("tlr_abc")).toBe("tlr_abc");
    expect(formatTyped("http://h/pair#token=tlr_x")).toBe("http://h/pair#token=tlr_x");
  });
});

describe("codeFromInput", () => {
  test("a bare code is itself, trimmed", () => {
    expect(codeFromInput("  tlr_abc123  ")).toBe("tlr_abc123");
  });

  test("a whole pairing link yields the code in its fragment", () => {
    expect(codeFromInput("http://100.110.136.102:57547/pair#token=37410745")).toBe("37410745");
    expect(codeFromInput("http://127.0.0.1:3000/pair#token=tlr_x&other=1")).toBe("tlr_x");
  });

  test("a link with no token in its fragment is handed on whole for the server to refuse", () => {
    expect(codeFromInput("http://host/pair#nothing")).toBe("http://host/pair#nothing");
  });
});
