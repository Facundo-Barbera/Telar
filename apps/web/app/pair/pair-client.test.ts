// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { codeFromInput } from "./pair-client";

describe("codeFromInput", () => {
  test("a bare code is itself, trimmed", () => {
    expect(codeFromInput("  tlr_abc123  ")).toBe("tlr_abc123");
  });

  test("a whole pairing link yields the token in its fragment", () => {
    expect(codeFromInput("http://100.110.136.102:57547/pair#token=tlr_fF2-Be2cfF_E")).toBe("tlr_fF2-Be2cfF_E");
    expect(codeFromInput("http://127.0.0.1:3000/pair#token=tlr_x&other=1")).toBe("tlr_x");
  });

  test("a link with no token in its fragment is handed on whole for the server to refuse", () => {
    expect(codeFromInput("http://host/pair#nothing")).toBe("http://host/pair#nothing");
  });
});
