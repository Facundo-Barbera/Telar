import { read } from "./files.mjs";

// Each of these went missing once while the app still compiled and rendered, just without its palette or faces.

/** `--font-*` variables the stylesheet reads that layout.tsx never loads with next/font. */
export function unloadedFonts(css, layout) {
  const readVars = new Set([...css.matchAll(/var\(\s*(--font-[a-z0-9-]+)/g)].map((match) => match[1]));
  return [...readVars].filter((name) => name !== "--font-sans" && name !== "--font-mono" && !layout.includes(`variable: "${name}"`));
}

export const webStylePipelineCheck = {
  name: "web-style-pipeline-is-wired",
  protects: "Tailwind, the dark variant, the no-flash theme script and every next/font face the stylesheet reads are wired",
  run() {
    const css = read("apps/web/src/app/globals.css");
    const layout = read("apps/web/src/app/layout.tsx");
    const postcss = read("apps/web/postcss.config.mjs");
    const failures = [];
    if (!postcss.includes("@tailwindcss/postcss")) failures.push("postcss.config.mjs: the Tailwind plugin is gone, so no utility is emitted");
    if (!css.includes('@import "tailwindcss"')) failures.push('globals.css: @import "tailwindcss" is gone');
    if (!css.includes("@custom-variant dark")) failures.push("globals.css: the dark variant is gone, so .dark rules are dead");
    if (!layout.includes('import "./globals.css"')) failures.push("layout.tsx: no longer imports globals.css");
    if (!layout.includes("THEME_INIT_SCRIPT")) failures.push("layout.tsx: the no-flash theme script is not in <head>");
    for (const name of unloadedFonts(css, layout)) failures.push(`layout.tsx: ${name} is read by globals.css but no next/font loader declares it`);
    return failures;
  },
};
