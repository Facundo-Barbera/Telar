import { expect, test } from "bun:test";
import { unloadedFonts } from "./web-style-pipeline.mjs";

test("a face the stylesheet reads but layout never loads is reported; Tailwind's own keys are not", () => {
  const css = "a { font-family: var(--font-inter), var(--font-sans); } b { font-family: var(--font-lost); }";
  expect(unloadedFonts(css, 'const inter = Inter({ variable: "--font-inter" });')).toEqual(["--font-lost"]);
});
