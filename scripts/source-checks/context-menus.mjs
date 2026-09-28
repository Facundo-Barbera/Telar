import { filesUnder, read } from "./files.mjs";

const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Problems with one file's context menu: a private ContextMenu, or an item that calls the engine itself. */
export function contextMenuProblems(source) {
  const code = withoutComments(source);
  if (!code.includes("<ContextMenuItem")) return [];
  const problems = [];
  if (!code.includes('from "@/ui/context-menu"')) problems.push("does not import @/ui/context-menu");
  if (/function ContextMenu\b/.test(code)) problems.push("defines a ContextMenu of its own");
  for (const item of code.match(/<ContextMenuItem[^>]*onClick=\{[^}]*\}/g) ?? []) {
    if (/\bfetch\(|\bapi\.\w+\(/.test(item)) problems.push(`an item fetches directly: ${item.slice(0, 80)}`);
  }
  return problems;
}

export const contextMenusCheck = {
  name: "context-menus-use-the-shared-primitive",
  protects: "every surface menu is @/ui/context-menu, and its items fire the surface's callbacks rather than calling the engine",
  run() {
    const files = filesUnder("apps/web/src", /\.tsx$/).filter((file) => file !== "apps/web/src/ui/context-menu.tsx");
    const menus = files.map((file) => [file, read(file)]).filter(([, source]) => withoutComments(source).includes("<ContextMenuItem"));
    if (menus.length < 5) return [`apps/web/src: found ${menus.length} surface menus, fewer than the cockpit has; the scan has rotted.`];
    return menus.flatMap(([file, source]) => contextMenuProblems(source).map((problem) => `${file}: ${problem}`));
  },
};
