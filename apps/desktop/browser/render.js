const MAX_LOG_ITEMS = 200;

const MAX_LOG_TEXT = 2_000;

function logText(value) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > MAX_LOG_TEXT ? `${text.slice(0, MAX_LOG_TEXT)}… (truncated, ${text.length} characters)` : text;
}

function pushCapped(list, entry) {
  list.push(entry);
  if (list.length > MAX_LOG_ITEMS) list.shift();
}

function axValue(node, key) {
  const value = node?.[key]?.value;
  return value === undefined || value === null ? "" : String(value);
}

const SNAPSHOT_TARGETABLE_ROLES = new Set([
  "button", "checkbox", "combobox", "link", "menuitem", "radio", "searchbox",
  "slider", "spinbutton", "switch", "tab", "textbox", "treeitem",
]);

const SNAPSHOT_MAX_INDENT = 12;
const SNAPSHOT_MAX_LINES = 500;

function snapshotDepths(nodes, byId) {
  const depths = new Map();
  for (const node of nodes) {
    if (depths.has(node.nodeId)) continue;
    const chain = [];
    let walk = node;
    while (walk && !depths.has(walk.nodeId)) {
      chain.push(walk);
      walk = walk.parentId ? byId.get(walk.parentId) : undefined;
    }
    let depth = walk ? depths.get(walk.nodeId) : -1;
    for (let i = chain.length - 1; i >= 0; i--) depths.set(chain[i].nodeId, ++depth);
  }
  return depths;
}

function renderSnapshot(nodes, { title = "", url = "", rootNodeId = null, maxDepth = null } = {}) {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const depths = snapshotDepths(nodes, byId);
  const scoped = new Map();
  const inScope = (node) => {
    if (rootNodeId === null) return true;
    const chain = [];
    let walk = node;
    while (walk && !scoped.has(walk.nodeId)) {
      if (walk.nodeId === rootNodeId) break;
      chain.push(walk);
      walk = walk.parentId ? byId.get(walk.parentId) : undefined;
    }
    const answer = walk ? (walk.nodeId === rootNodeId ? true : scoped.get(walk.nodeId)) : false;
    for (const link of chain) scoped.set(link.nodeId, answer);
    return answer;
  };
  const rootDepth = rootNodeId === null ? 0 : depths.get(rootNodeId) ?? 0;
  const lines = [`Page: ${title}`, `URL: ${url}`, ""];
  const refs = new Map();
  let nextRef = 1;
  for (const node of nodes) {
    if (node.ignored) continue;
    if (!inScope(node)) continue;
    const relative = (depths.get(node.nodeId) ?? 0) - rootDepth;
    if (relative < 0) continue;
    if (maxDepth !== null && relative > maxDepth) continue;
    const role = axValue(node, "role");
    const name = axValue(node, "name").replace(/\s+/g, " ").trim();
    const value = axValue(node, "value").replace(/\s+/g, " ").trim();
    const backendNodeId = Number(node.backendDOMNodeId || 0);
    const canTarget = backendNodeId > 0 && (SNAPSHOT_TARGETABLE_ROLES.has(role) || role === "img");
    if (!name && !value && !canTarget) continue;
    let ref = "";
    if (canTarget) {
      ref = `e${nextRef++}`;
      refs.set(ref, backendNodeId);
    }
    const label = [role || "node", name ? `"${name}"` : "", value ? `value="${value}"` : "", ref ? `[ref=${ref}]` : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(`${"  ".repeat(Math.min(SNAPSHOT_MAX_INDENT, relative))}- ${label}`);
    if (lines.length >= SNAPSHOT_MAX_LINES) {
      lines.push("- … snapshot truncated");
      break;
    }
  }
  return { text: lines.join("\n"), refs };
}

const CONSOLE_LEVEL_RANK = { debug: 0, verbose: 0, trace: 0, log: 1, info: 1, warning: 2, warn: 2, error: 3 };
const CONSOLE_DEFAULT_RANK = 1;

function consoleRank(level) {
  const rank = CONSOLE_LEVEL_RANK[String(level || "").toLowerCase()];
  return rank === undefined ? CONSOLE_DEFAULT_RANK : rank;
}

function renderConsole(entries, { level = "info", all = false } = {}) {
  const floor = all ? Number.NEGATIVE_INFINITY : consoleRank(level);
  const kept = entries.filter((entry) => consoleRank(entry.level) >= floor);
  if (kept.length === 0) {
    return entries.length === 0
      ? "No console messages captured."
      : `No console messages at ${level} or above (${entries.length} quieter ones captured — pass all: true for those).`;
  }
  return kept.map((entry) => `[${entry.level}] ${entry.text}`).join("\n");
}

function renderNetwork(entries, { filter = "" } = {}) {
  const needle = String(filter || "");
  const kept = entries.filter((entry) => !needle || entry.url.includes(needle));
  if (kept.length === 0) {
    return entries.length === 0
      ? "No network requests captured."
      : `No network requests matching "${needle}" (${entries.length} captured).`;
  }
  return kept.map((entry) => `${entry.method} ${entry.url}`).join("\n");
}

module.exports = { MAX_LOG_ITEMS, MAX_LOG_TEXT, logText, pushCapped, renderSnapshot, renderConsole, renderNetwork };
