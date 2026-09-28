
export type FileTreeNode =
  | { kind: "file"; path: string; name: string }
  | { kind: "directory"; path: string; name: string; children: FileTreeNode[] };

function compareNodes(left: FileTreeNode, right: FileTreeNode): number {
  if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
  return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
}

type Building = { dirs: Map<string, Building>; files: string[] };

function emptyBuilding(): Building {
  return { dirs: new Map(), files: [] };
}

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

export const MAX_SEARCH_MATCHES = 400;

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

export function flattenTree(nodes: readonly FileTreeNode[], expanded: ReadonlySet<string>, depth = 0): FileTreeRow[] {
  const rows: FileTreeRow[] = [];
  for (const node of nodes) {
    rows.push({ node, depth });
    if (node.kind === "directory" && expanded.has(node.path)) rows.push(...flattenTree(node.children, expanded, depth + 1));
  }
  return rows;
}

export function directoryPaths(nodes: readonly FileTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (node.kind !== "directory") continue;
    paths.push(node.path);
    paths.push(...directoryPaths(node.children));
  }
  return paths;
}

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
