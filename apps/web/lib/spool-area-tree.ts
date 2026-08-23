/**
 * AN AREA'S NAME IS A PATH — `docs/spool-loops.md` §13.7. The store keeps
 * ONE STRING per subject (`SpoolSubject.area`, `SpoolLobbyArea.name`); depth
 * is a naming convention the user adopts ("Work / Focaltec"), never a
 * structure the system maintains. Everything in this file is PURE
 * RENDERING over that one string — no parent pointers, no tree table, no
 * second store. Both the rail (`warehouse-nav.tsx`) and the lobby
 * (`lobby.tsx`) build the same shape from it, so the two surfaces teach the
 * same grammar without sharing a component.
 */

export const AREA_PATH_SEP = " / ";

/** Split on " / ", trimmed, empties dropped — the engine's own rule, so
 *  "Work /  " and "Work" name the same node and a stray double separator
 *  never mints an empty container. */
export function splitAreaPath(area: string): string[] {
  return area
    .split(AREA_PATH_SEP)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function joinAreaPath(segments: string[]): string {
  return segments.join(AREA_PATH_SEP);
}

export function pathsEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((segment, i) => segment === b[i]);
}

/**
 * SEGMENT-BOUNDARY PREFIX, NOT A STRING PREFIX — §13.7's own warning:
 * "Work" must not match "Workshop". `prefix` is a real prefix of `path`
 * only when every one of its segments equals `path`'s segment at the same
 * index; a partial match on the LAST segment's characters never counts.
 */
export function pathIsPrefixOf(prefix: string[], path: string[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((segment, i) => segment === path[i]);
}

/**
 * THE CONTAINER-RENAME'S OWN ARITHMETIC — dropping container `from` onto
 * container `to` recategorizes every subject whose path starts with `from`:
 * the `from` prefix is replaced by `to`, and whatever sat past it rides
 * along unchanged. A subject whose area does not sit under `from` is
 * returned untouched, so a blind `map` over every subject is always safe.
 */
export function renamePathPrefix(area: string, from: string[], to: string[]): string {
  const path = splitAreaPath(area);
  if (!pathIsPrefixOf(from, path)) return area;
  return joinAreaPath([...to, ...path.slice(from.length)]);
}

export type AreaTreeNode<T> = {
  /** The joined path — also the exact `area` string a subject filed
   *  directly at this node carries. `"__ghost"` for the one container that
   *  is not a stored value: subjects with no area at all. */
  key: string;
  path: string[];
  label: string;
  depth: number;
  ghost: boolean;
  /** Entries whose area is EXACTLY this node's path — never a descendant's. */
  lines: T[];
  children: AreaTreeNode<T>[];
};

/**
 * BUILD THE CONTAINER TREE — one node per distinct path prefix that some
 * entry's area actually names, sorted alphabetically at each level like the
 * flat grouping it replaces. Un-areaed entries collect under one ghost
 * container so they are never rendered floating (§13.7: "never floating").
 */
export function buildAreaTree<T>(entries: T[], getArea: (entry: T) => string | undefined): AreaTreeNode<T>[] {
  type Mutable = AreaTreeNode<T> & { childMap: Map<string, Mutable> };
  const roots = new Map<string, Mutable>();
  const ghostLines: T[] = [];

  const ensure = (map: Map<string, Mutable>, path: string[]): Mutable => {
    const label = path[path.length - 1];
    let node = map.get(label);
    if (!node) {
      node = { key: joinAreaPath(path), path, label, depth: path.length - 1, ghost: false, lines: [], children: [], childMap: new Map() };
      map.set(label, node);
    }
    return node;
  };

  for (const entry of entries) {
    const area = getArea(entry);
    const path = area ? splitAreaPath(area) : [];
    if (path.length === 0) {
      ghostLines.push(entry);
      continue;
    }
    let map = roots;
    let node: Mutable | undefined;
    for (let i = 0; i < path.length; i++) {
      node = ensure(map, path.slice(0, i + 1));
      map = node.childMap;
    }
    node!.lines.push(entry);
  }

  const finish = (map: Map<string, Mutable>): AreaTreeNode<T>[] =>
    [...map.values()]
      .sort((a, b) => a.label.localeCompare(b.label))
      .map((node) => ({ ...node, children: finish(node.childMap) }));

  const tree = finish(roots);
  if (ghostLines.length > 0) {
    tree.push({ key: "__ghost", path: [], label: "No area yet", depth: 0, ghost: true, lines: ghostLines, children: [] });
  }
  return tree;
}

export function findAreaNode<T>(tree: AreaTreeNode<T>[], key: string): AreaTreeNode<T> | undefined {
  for (const node of tree) {
    if (node.key === key) return node;
    const found = findAreaNode(node.children, key);
    if (found) return found;
  }
  return undefined;
}

/**
 * A CONTAINER'S ROLLUP FACTS — subject count and whatever-needs-you total,
 * computed from what sits beneath it: its own lines plus every descendant's.
 * Never stored, never a second count that could disagree with the rows it
 * describes.
 */
export function rollupCount<T>(node: AreaTreeNode<T>, getNeeds: (entry: T) => number): { subjects: number; needs: number } {
  let subjects = node.lines.length;
  let needs = node.lines.reduce((sum, entry) => sum + getNeeds(entry), 0);
  for (const child of node.children) {
    const nested = rollupCount(child, getNeeds);
    subjects += nested.subjects;
    needs += nested.needs;
  }
  return { subjects, needs };
}

/**
 * A CONTAINER RENAME'S OWN WIRE WORK — shared by `warehouse-nav.tsx`'s
 * drag-to-rename tree and `warehouse.tsx`'s Areas table, which is the whole
 * reason this moved out of the rail: two surfaces state the SAME fact
 * ("`from` is now called `to`") through the SAME PATCH, and a second
 * hand-rolled copy of the `Promise.allSettled` loop would risk the two
 * drifting on what "every affected subject" means.
 *
 * ONE PATCH PER AFFECTED SUBJECT, and every one is sent — this function does
 * not stop at the first refusal, because a rename is one gesture that
 * happens to touch many subjects and a caller needs to know exactly which of
 * them landed, not just that something somewhere failed. Callers that want
 * "all or nothing, optimistically" (the rail) build that on top by reverting
 * their own overlay when `error` comes back non-null; this function makes no
 * attempt to undo a PATCH that already reached the engine.
 */
export async function renameAreaPrefixAcrossSubjects(
  subjects: ReadonlyArray<{ key: string; area?: string }>,
  from: string,
  to: string,
): Promise<{ renamed: string[]; error: string | null }> {
  const fromPath = splitAreaPath(from);
  const toPath = splitAreaPath(to);
  const affected = subjects.filter((s) => s.area && pathIsPrefixOf(fromPath, splitAreaPath(s.area)));
  if (affected.length === 0) return { renamed: [], error: null };

  const targets = affected.map((s) => ({ key: s.key, area: renamePathPrefix(s.area as string, fromPath, toPath) }));
  const results = await Promise.allSettled(
    targets.map(({ key, area }) =>
      fetch(`/api/spool/subjects/${encodeURIComponent(key)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ area }),
      }).then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        return key;
      }),
    ),
  );
  const renamed: string[] = [];
  let error: string | null = null;
  for (const result of results) {
    if (result.status === "fulfilled") renamed.push(result.value);
    else if (!error) error = result.reason instanceof Error ? result.reason.message : String(result.reason);
  }
  return { renamed, error };
}
