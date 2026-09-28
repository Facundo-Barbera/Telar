import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createIconPng, type Rasterize } from "./icon-png";

const svg = (body = "") => ({ bytes: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg">${body}</svg>`), contentType: "image/svg+xml" });
const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icon-png-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fakeRasterizer() {
  const calls: Array<{ input: string; edge: number }> = [];
  const rasterize: Rasterize = async (input, output, edge) => {
    calls.push({ input, edge });
    fs.writeFileSync(output, Buffer.from(`png:${fs.readFileSync(input, "utf8").length}`));
  };
  return { calls, rasterize };
}

describe("iconPng", () => {
  test("passes a raster icon through untouched", async () => {
    const { calls, rasterize } = fakeRasterizer();
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    expect(await createIconPng(tempDir(), rasterize)({ bytes, contentType: "image/png" })).toBe(bytes);
    expect(calls).toHaveLength(0);
  });

  test("rasterizes an SVG once at a bounded size, then serves it from the disk cache", async () => {
    const dir = tempDir();
    const { calls, rasterize } = fakeRasterizer();
    const first = await createIconPng(dir, rasterize)(svg());
    const again = await createIconPng(dir, rasterize)(svg());
    expect(first?.toString()).toStartWith("png:");
    expect(again).toEqual(first!);
    expect(calls).toEqual([{ input: expect.stringContaining(dir), edge: 128 }]);
    expect(fs.readdirSync(dir).filter((name) => !name.endsWith(".png") || name.includes(".tmp."))).toEqual([]);
  });

  test("shares one render between concurrent requests for the same icon", async () => {
    const { calls, rasterize } = fakeRasterizer();
    const iconPng = createIconPng(tempDir(), rasterize);
    await Promise.all([iconPng(svg()), iconPng(svg()), iconPng(svg())]);
    expect(calls).toHaveLength(1);
  });

  test("refuses an SVG that references anything outside itself", async () => {
    const { calls, rasterize } = fakeRasterizer();
    const iconPng = createIconPng(tempDir(), rasterize);
    expect(await iconPng(svg(`<image href="file:///etc/hosts"/>`))).toBeUndefined();
    expect(await iconPng(svg(`<use xlink:href="https://example.com/a.svg#x"/>`))).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(await iconPng(svg(`<use href="#local"/>`))).toBeDefined();
  });

  test("a failed render is not cached", async () => {
    let fail = true;
    const rasterize: Rasterize = async (_input, output) => {
      if (fail) throw new Error("sips failed");
      fs.writeFileSync(output, "png");
    };
    const iconPng = createIconPng(tempDir(), rasterize);
    expect(await iconPng(svg())).toBeUndefined();
    fail = false;
    expect(await iconPng(svg())).toEqual(Buffer.from("png"));
  });
});
