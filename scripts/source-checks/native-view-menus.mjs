import { filesUnder, read } from "./files.mjs";

// A menu over the native browser view renders behind the page unless it takes the view down while open.

function openingTag(source, start) {
  let depth = 0;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

function balanced(source, open, pair) {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === pair[0]) depth += 1;
    else if (source[i] === pair[1]) {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i);
    }
  }
  return "";
}

const identifiers = (expression) => expression.match(/[A-Za-z_$][\w$]*/g) ?? [];

function menuRoots(source) {
  return [...source.matchAll(/<(Popover|DropdownMenu|ContextMenu)(?![A-Za-z])/g)].map((match) => {
    const tag = openingTag(source, match.index);
    const at = tag.search(/(?:^|\s)open=\{/);
    return { name: match[1], open: at === -1 ? null : balanced(tag, tag.indexOf("{", at), "{}"), line: source.slice(0, match.index).split("\n").length };
  });
}

/** `Name:line` for each menu root whose `open` state is not handed to `useNativeViewOverlay`. */
export function unguardedMenus(source) {
  const guarded = new Set();
  for (const match of source.matchAll(/useNativeViewOverlay\(/g)) {
    for (const name of identifiers(balanced(source, source.indexOf("(", match.index), "()"))) guarded.add(name);
  }
  return menuRoots(source)
    .filter((menu) => menu.open === null || !identifiers(menu.open).some((name) => guarded.has(name)))
    .map((menu) => `${menu.name}:${menu.line}`);
}

const overTheView = (file, source) =>
  /(^|\/)right-panel[^/]*\.tsx$/.test(file) ||
  (file.startsWith("apps/web/src/features/browser/") && !file.startsWith("apps/web/src/features/browser/panes/")) ||
  source.includes("useNativeViewOverlay(");

export const nativeViewMenusCheck = {
  name: "native-view-menus-hide-the-view",
  protects: "every menu drawn over the desktop browser view hands its open state to useNativeViewOverlay",
  run() {
    const scanned = filesUnder("apps/web/src", /\.tsx$/).map((file) => [file, read(file)]).filter(([file, source]) => overTheView(file, source));
    if (scanned.reduce((count, [, source]) => count + menuRoots(source).length, 0) === 0) {
      return ["apps/web/src: found no menu over the native view at all, so this check proved nothing; re-anchor overTheView()."];
    }
    return scanned.flatMap(([file, source]) => unguardedMenus(source).map((menu) => `${file}: ${menu} is not covered by useNativeViewOverlay`));
  },
};
