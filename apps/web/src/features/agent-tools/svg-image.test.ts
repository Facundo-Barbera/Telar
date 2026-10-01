import { expect, test } from "bun:test";
import { installTestDom } from "@/test/dom";
import { svgImage } from "./svg-image";

installTestDom();

const decoded = (url: string) => decodeURIComponent(url.slice(url.indexOf(",") + 1));

test("a diagram sized to its container gets its natural size from the viewBox", () => {
  const image = svgImage('<svg xmlns="http://www.w3.org/2000/svg" width="100%" style="max-width: 812px; background: red" viewBox="0 0 812 500"><g/></svg>')!;
  expect([image.width, image.height]).toEqual([812, 500]);
  expect(decoded(image.url)).toContain('width="812"');
  expect(decoded(image.url)).not.toContain("max-width");
  expect(decoded(image.url)).toContain("background: red");
});

test("explicit pixel sizes win, and markup that is not an svg is refused", () => {
  expect(svgImage('<svg width="40px" height="30" viewBox="0 0 400 300"/>')).toMatchObject({ width: 40, height: 30 });
  expect(svgImage("<html><body>hi</body></html>")).toBeUndefined();
  expect(svgImage("<svg><unclosed></svg>")).toBeUndefined();
});
