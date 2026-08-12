// Short-lived server-side store for in-flight MCP OAuth connect flows
// (docs/mcp-oauth-design.md §5). Keyed by the OAuth `state`, each entry holds
// the ConnectContext that beginConnect produced (state, PKCE codeVerifier,
// redirectUri, resolved AS + client + resource) so the /callback route can
// finish the code exchange after the browser round-trips through the
// authorization server. Persisted to a JSON under ~/.telar so a mid-flow reload
// or dev-server restart doesn't strand the flow; entries expire after TTL_MS and
// are swept on every access. The file can hold a PKCE verifier and a confidential
// client secret, so it is written 0600 — never trusted from the client.
import fs from "node:fs";
import path from "node:path";
import { telarDir, type ConnectContext } from "@telar/core";

const TTL_MS = 10 * 60 * 1000; // ~10 minutes — a connect must complete within.

export type PendingFlow = {
  project: string;
  server: string;
  ctx: ConnectContext; // carries state, codeVerifier, redirectUri, as, client, resource
  createdAt: number;
};

type PendingStore = { version: number; flows: Record<string, PendingFlow> };

const storeFile = () => path.join(telarDir(), "mcp-oauth-pending.json");

function readStore(): PendingStore {
  try {
    const data = JSON.parse(fs.readFileSync(storeFile(), "utf8"));
    return { version: data.version ?? 1, flows: data.flows ?? {} };
  } catch {
    return { version: 1, flows: {} };
  }
}

function writeStore(store: PendingStore): void {
  const file = storeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // may hold a PKCE verifier / client secret
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

function isExpired(flow: PendingFlow, now = Date.now()): boolean {
  return now - flow.createdAt >= TTL_MS;
}

// Drop expired entries in place; returns whether anything changed.
function prune(store: PendingStore, now = Date.now()): boolean {
  let changed = false;
  for (const [state, flow] of Object.entries(store.flows)) {
    if (isExpired(flow, now)) {
      delete store.flows[state];
      changed = true;
    }
  }
  return changed;
}

// Stash a fresh flow, keyed by its own state. Sweeps stale entries on the way in.
export function putPending(flow: PendingFlow): void {
  const store = readStore();
  prune(store);
  store.flows[flow.ctx.state] = flow;
  writeStore(store);
}

// Single-use: remove & return the flow for `state`. Unknown or expired →
// undefined. The read-modify-write is NOT atomic, so two concurrent callbacks
// for the same state could both observe the flow (TOCTOU); acceptable for a
// local single-user app because the authorization-code single-use check at the
// token endpoint is the real backstop — a replayed code fails the exchange
// there. Runs a GC pass and persists it on the same read.
export function takePending(state: string): PendingFlow | undefined {
  if (!state) return undefined;
  const store = readStore();
  prune(store); // expired entries are gone from `flows` after this
  const flow = store.flows[state];
  if (flow) delete store.flows[state];
  writeStore(store);
  return flow;
}

// Opportunistic sweep of expired flows; safe to call any time.
export function gcPending(): void {
  const store = readStore();
  if (prune(store)) writeStore(store);
}
