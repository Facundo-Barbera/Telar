/**
 * WHAT THE OPEN MENU'S ROWS ACTUALLY LOOK LIKE AT 14, 16 AND 20 PIXELS —
 * without launching Telar, a dev server or a headless browser.
 *
 *     node apps/desktop/render-opener-icons.mjs [outDir]
 *
 * Issue #398 is a claim about rasterisation, and a claim about rasterisation is
 * only reviewable as pixels. This builds one sheet per size showing each
 * installed opener twice — its REAL icon on the left, the vendored vector mark
 * the app falls back to on the right — and hands the sheets to `rsvg-convert`.
 *
 * WHERE THE BITMAP COMES FROM, AND WHY IT IS NOT `getFileIcon`. The shipping
 * path is `app.getFileIcon(bundle, { size: "normal" })`, which needs a running
 * Electron app; this script deliberately has none. It reads the same artwork
 * the same way macOS does — the bundle's own `.icns`, resampled to 32px by
 * `sips` — so the bytes are the app's published icon at the size the shell
 * asks for. What it is NOT is proof that `getFileIcon` returns exactly that
 * buffer; `workspace-openers.test.js` is what pins the shell's half.
 *
 * The geometry is the component's, not an approximation of it: the same whole
 * pixel box, the same 1px-inset rounded mask at 18% of the box, the same
 * 24-unit viewBox scaled down for the fallback marks. Two device scales are
 * written for each sheet — @1x, and the @2x a Retina Mac actually paints.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { discoverOpeners, FINDER_BUNDLE } from "./workspace-openers.js";

const SIZES = [14, 16, 20];
/** Mirrors `SQUIRCLE` in components/session/opener-icon.tsx. */
const SQUIRCLE = 0.18;
const ROW = 30;
const HEAD = 34;
const WIDTH = 280;
const BITMAP_X = 16;
const VECTOR_X = 56;
const LABEL_X = 96;

/**
 * Which `.icns` in the bundle is the APP's, which is a question a directory
 * listing cannot answer: VS Code ships ~40 of them and all but one belong to a
 * document type, so picking by filename hands you a "C source file" icon.
 * `CFBundleIconFile` is where the bundle says which is its own.
 */
function iconFileName(bundlePath) {
  const resources = path.join(bundlePath, "Contents", "Resources");
  try {
    const named = execFileSync("plutil", ["-extract", "CFBundleIconFile", "raw", "-o", "-", path.join(bundlePath, "Contents", "Info.plist")], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (named) return named.endsWith(".icns") ? named : `${named}.icns`;
  } catch {
    // A bundle with no such key falls through to the listing below.
  }
  try {
    return readdirSync(resources).find((entry) => entry.endsWith(".icns"));
  } catch {
    return undefined;
  }
}

/** The bundle's icon as a 32px PNG data URL, or undefined. `sips` reads the
 *  `.icns` macOS itself draws from, and launches nothing. */
function bundleIcon(bundlePath) {
  const resources = path.join(bundlePath, "Contents", "Resources");
  const icns = iconFileName(bundlePath);
  if (!icns) return undefined;
  const scratch = mkdtempSync(path.join(tmpdir(), "telar-icon-"));
  try {
    const out = path.join(scratch, "icon.png");
    execFileSync("sips", ["-s", "format", "png", "--resampleHeightWidth", "32", "32", path.join(resources, icns), "--out", out], { stdio: "ignore" });
    return `data:image/png;base64,${readFileSync(out).toString("base64")}`;
  } catch {
    return undefined;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** The vendored fallback marks, read out of the component itself so a sheet
 *  cannot drift from what the app draws. */
function vectorMarks() {
  const source = readFileSync(new URL("../web/components/session/opener-icon.tsx", import.meta.url), "utf8");
  const table = source.slice(source.indexOf("const MARKS"), source.indexOf("\n};"));
  return Object.fromEntries([...table.matchAll(/\n {2}(\w+):\s*\n?\s*"([^"]+)"/g)].map(([, key, d]) => [key, d]));
}

const escape = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const FONT = "-apple-system, Helvetica";

function sheet(rows, size) {
  const radius = Math.round(size * SQUIRCLE);
  const top = (index) => HEAD + index * ROW + (ROW - size) / 2 - ROW / 2;
  const baseline = (index) => HEAD + index * ROW + 4;

  const defs = rows
    .map(
      (_row, index) =>
        // The component's `clip-path: inset(1px round Npx)`, as the equivalent
        // rounded rect — librsvg draws a clipPath, not a CSS basic shape.
        `<clipPath id="m${index}"><rect x="${BITMAP_X + 1}" y="${top(index) + 1}" width="${size - 2}" height="${size - 2}" rx="${radius}" ry="${radius}"/></clipPath>`,
    )
    .join("");

  const body = rows
    .map((row, index) => {
      const bitmap = row.iconDataUrl
        ? `<image x="${BITMAP_X}" y="${top(index)}" width="${size}" height="${size}" href="${row.iconDataUrl}" clip-path="url(#m${index})"/>`
        : `<text x="${BITMAP_X}" y="${baseline(index)}" font-size="9" font-family="${FONT}" fill="#aaa">—</text>`;
      const vector = row.mark
        ? `<g transform="translate(${VECTOR_X} ${top(index)}) scale(${size / 24})"><path d="${row.mark}" fill="#111" shape-rendering="geometricPrecision"/></g>`
        : `<text x="${VECTOR_X}" y="${baseline(index)}" font-size="9" font-family="${FONT}" fill="#aaa">neutral</text>`;
      return `${bitmap}${vector}<text x="${LABEL_X}" y="${baseline(index)}" font-size="11" font-family="${FONT}" fill="#111">${escape(row.label)}</text>`;
    })
    .join("");

  const height = HEAD + ROW * rows.length;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">
<defs>${defs}</defs>
<rect width="${WIDTH}" height="${height}" fill="#fff"/>
<text x="${BITMAP_X}" y="18" font-size="10" font-family="${FONT}" fill="#666">real</text>
<text x="${VECTOR_X}" y="18" font-size="10" font-family="${FONT}" fill="#666">vector</text>
<text x="${LABEL_X}" y="18" font-size="10" font-family="${FONT}" fill="#666">at ${size}px</text>
${body}</svg>`;
}

const outDir = path.resolve(process.argv[2] ?? "icon-renders");
mkdirSync(outDir, { recursive: true });
const marks = vectorMarks();
const rows = [
  // Finder is not in the opener table — the reveal row is the renderer's own —
  // but it is a row with a logo on it, and #398 is largely about that logo.
  { id: "reveal", label: "Reveal in Finder", path: FINDER_BUNDLE },
  ...discoverOpeners().map((opener) => ({ ...opener, mark: opener.icon ? marks[opener.icon] : undefined })),
].map((row) => ({ ...row, iconDataUrl: bundleIcon(row.path) }));

for (const size of SIZES) {
  const svgPath = path.join(outDir, `openers-${size}px.svg`);
  writeFileSync(svgPath, sheet(rows, size));
  for (const zoom of [1, 2]) {
    execFileSync("rsvg-convert", ["--zoom", String(zoom), "-o", path.join(outDir, `openers-${size}px@${zoom}x.png`), svgPath]);
  }
}

console.log(`${rows.length} rows × ${SIZES.length} sizes → ${outDir}`);
for (const row of rows) if (!row.iconDataUrl) console.log(`  no bitmap for ${row.label} (${row.path})`);
