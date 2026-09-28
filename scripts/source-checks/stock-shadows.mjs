import { filesUnder, read } from "./files.mjs";

export const STOCK_SHADOW = /\bshadow-(2?xs|sm|md|lg|xl|2xl)\b/;

export const stockShadowsCheck = {
  name: "no-stock-shadows-in-ui",
  protects: "the design system's primitives reach for the --shadow-1..3 ladder, never Tailwind's stock shadows",
  run() {
    const files = filesUnder("apps/web/src/ui", /\.tsx?$/);
    if (files.length < 10) return [`apps/web/src/ui: only ${files.length} files found; the scan has rotted.`];
    return files.flatMap((file) =>
      read(file).split("\n").flatMap((line, index) => (STOCK_SHADOW.test(line) ? [`${file}:${index + 1}: ${line.trim().slice(0, 120)} — use shadow-1, shadow-2 or shadow-3`] : [])),
    );
  },
};
