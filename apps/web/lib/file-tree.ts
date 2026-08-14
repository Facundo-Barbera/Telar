/**
 * A FLAT LIST OF PATHS, TURNED INTO SOMETHING WORTH LOOKING AT.
 *
 * The engine answers with paths (`WorkspaceListing`) because that is the
 * smallest true thing and because search wants a list, not a graph. Every
 * decision about how those paths GROUP, SORT, COLLAPSE and FILTER is a
 * presentation decision, so all of it is here — pure, and testable without a
 * repository or a browser.
 *
 * THREE OF THOSE DECISIONS ARE BORROWED, deliberately, from t3 code's file
 * browser, because they are what makes a monorepo tree usable rather than merely
 * correct:
 *
 *   - SINGLE-CHILD CHAINS COLLAPSE. `packages/core/src/loom/steps/` is six clicks
 *     and six rows to reach one directory that has anything in it. Merged into
 *     one row it is one click, and no information is lost — the full path is
 *     right there in the label.
 *   - ONE LEVEL IS OPEN. Enough to see the shape of the repository, few enough
 *     rows that the panel is not a wall of text before you have asked anything.
 *   - SEARCH HIDES NON-MATCHES rather than highlighting them. In a thousand-file
 *     tree, highlighting is asking somebody to scroll for a colour.
 *
 * WHAT IS NOT BORROWED: t3 code's tree is a third-party widget rendering into a
 * shadow root, and the panel has to inject CSS variables through `unsafeCSS` to
 * make it match the app it lives in. Ours renders with the same primitives as
 * every other row in this panel, so it matches by construction.
 */

export type FileTreeNode =
  | { kind: "file"; path: string; name: string }
  | { kind: "directory"; path: string; name: string; children: FileTreeNode[] };

/**
 * Directories before files, then natural order.
 *
 * `numeric` so `step-2` sorts before `step-10`, and `sensitivity: "base"` so a
 * capitalised name does not sort into its own block at the top — `README.md`
 * belongs next to `package.json`, not above every lowercase file in the
 * directory, which is what a plain codepoint sort does.
 */
function compareNodes(left: FileTreeNode, right: FileTreeNode): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

type Building = { dirs: Map<string, Building>; files: string[] };

function emptyBuilding(): Building {
  return { dirs: new Map(), files: [] };
}

/**
 * Merge a directory that contains exactly one directory and nothing else.
 *
 * Recursive, and the LABEL is what grows — `core/src/loom` — while the `path`
 * stays the real path of the directory the row actually represents. Expanding it
 * reveals the contents of the deepest one, which is the only thing anybody
 * wanted from those five clicks.
 */
function collapse(node: FileTreeNode): FileTreeNode {
  if (node.kind === "file") return node;
  const children = node.children.map(collapse);
  const only = children[0];
  if (children.length === 1 && only?.kind === "directory") {
    return { kind: "directory", path: only.path, name: `${node.name}/${only.name}`, children: only.children };
  }
  return { kind: "directory", path: node.path, name: node.name, children };
}

function toNodes(building: Building, prefix: string): FileTreeNode[] {
  const nodes: FileTreeNode[] = [];
  for (const [name, child] of building.dirs) {
    const path = prefix ? `${prefix}/${name}` : name;
    nodes.push({ kind: "directory", path, name, children: toNodes(child, path) });
  }
  for (const name of building.files) nodes.push({ kind: "file", path: prefix ? `${prefix}/${name}` : name, name });
  return nodes.sort(compareNodes);
}

/**
 * Build the tree. Returns the ROOT'S CHILDREN, not a root node: the root is the
 * workspace itself, it is already named in the panel's header, and a row saying
 * `/Users/you/Projects/thing` above everything would be one click of overhead on
 * every visit.
 */
export function buildFileTree(paths: readonly string[]): FileTreeNode[] {
  const root = emptyBuilding();
  for (const path of paths) {
    const segments = path.split("/").filter(Boolean);
    const name = segments.pop();
    if (name === undefined) continue;
    let cursor = root;
    for (const segment of segments) {
      let next = cursor.dirs.get(segment);
      if (!next) {
        next = emptyBuilding();
        cursor.dirs.set(segment, next);
      }
      cursor = next;
    }
    cursor.files.push(name);
  }
  return toNodes(root, "").map(collapse);
}

/**
 * How many matches a search will draw.
 *
 * Typing one letter matches most of a repository, and building a thousand-node
 * tree on every keystroke to render a scroller nobody will reach the bottom of is
 * work for nothing. The cap is reported so the surface can say what it dropped —
 * a search that silently stops at 400 reads as "there are only 400".
 */
export const MAX_SEARCH_MATCHES = 400;

/**
 * The paths a query keeps.
 *
 * MATCHED ON THE WHOLE PATH, not the filename, which is what makes `engine`
 * bring back everything under `apps/engine` and `panel` bring back
 * `components/right-panel.tsx`. Case-insensitive, plain substring: a person
 * typing into a file search is remembering a fragment, not writing a pattern, and
 * a regex here would turn a typed `(` into an error state.
 */
export function matchFiles(
  paths: readonly string[],
  query: string,
  limit = MAX_SEARCH_MATCHES,
): { files: string[]; matches: number; truncated: boolean } {
  const needle = query.trim().toLowerCase();
  if (!needle) return { files: [...paths], matches: paths.length, truncated: false };
  const files: string[] = [];
  let matches = 0;
  for (const path of paths) {
    if (!path.toLowerCase().includes(needle)) continue;
    matches += 1;
    if (files.length < limit) files.push(path);
  }
  return { files, matches, truncated: matches > files.length };
}

export type FileTreeRow = { node: FileTreeNode; depth: number };

/**
 * The tree as a flat list of visible rows.
 *
 * FLAT BECAUSE THE KEYBOARD IS FLAT. Up and down move between adjacent VISIBLE
 * rows regardless of nesting, which is what every tree in every file manager
 * does, and expressing that against a nested render is a walk on every keypress.
 * It also means the row count is knowable, which is how the surface can say
 * "showing 400 of 1,127".
 */
export function flattenTree(nodes: readonly FileTreeNode[], expanded: ReadonlySet<string>, depth = 0): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "directory" && expanded.has(node.path)) rows.push(...flattenTree(node.children, expanded, depth + 1));
  }
  return rows;
}

/** Every directory in the tree — what "expand everything" means while a search
 *  is running, since a filtered tree is small and hiding its matches behind
 *  chevrons would defeat the search. */
export function directoryPaths(nodes: readonly FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...directoryPaths(node.children));
  }
  return paths;
}

/**
 * Every directory that contains a changed file, at any depth.
 *
 * So a collapsed `apps/` can carry the mark that something inside it is dirty —
 * which is the whole reason to tint a tree in a tool where an agent is the one
 * doing the writing. Derived from the changed paths rather than by walking the
 * tree, because the changed set is the small one.
 */
export function ancestorsOf(paths: Iterable<string>): Set<string> {
  const dirs = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    segments.pop();
    let prefix = "";
    for (const segment of segments) {
      prefix = prefix ? `${prefix}/${segment}` : segment;
      dirs.add(prefix);
    }
  }
  return dirs;
}
