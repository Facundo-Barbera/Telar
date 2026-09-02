// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { encodeQr } from "./qr";

describe("qr encoding", () => {
  test("produces a square bitstring", () => {
    const { size, bits } = encodeQr("http://100.110.136.102:3000/pair#token=tlr_abc");
    expect(bits.length).toBe(size * size);
    expect(bits).toMatch(/^[01]+$/);
  });

  test("a short input lands on the smallest version", () => {
    expect(encodeQr("t").size).toBe(21);
  });
});
