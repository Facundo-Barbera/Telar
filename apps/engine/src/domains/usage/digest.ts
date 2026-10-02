import type { TokenUsage, UsageDigest, UsageDigestSchedule, UsageDigestSession, UsageDigestTotals, UsageDigestTree, UsageDigestWindow } from "@telar/engine-client";
import type { Statement } from "../../platform/db/schema";
import { priceTokens, type RatesTable } from "./pricing";
import { usageSignals } from "./signals";

type Db = { statement(sql: string): Statement };

export type DigestInput = {
  db: Db;
  now: number;
  rates: RatesTable;
  /** Provider-log totals over 30 days, whatever ran them. */
  providerLogs: Array<{ provider: string; tokens: number; costUsd: number }>;
  config: UsageDigest["config"];
  projectName: (projectId: string) => string | undefined;
  /** Sessions the digest leaves out, such as a running diagnosis. */
  exclude?: (sessionId: string) => boolean;
};

const DAY_MS = 86_400_000;
const WINDOWS: Record<UsageDigestWindow, number> = { "24h": DAY_MS, "7d": 7 * DAY_MS, "30d": 30 * DAY_MS };
const TOP_SESSIONS = 20;
const LARGE_ITEM_BYTES = 50_000;

type SessionDoc = {
  id: string;
  title: string;
  driver: string;
  model: string;
  effort?: string;
  projectId?: string;
  parent?: string;
  createdAt: number;
  contextUsed?: number;
  contextMax?: number;
  purpose?: string;
};

type Row = { sessionId: string; origin: string; turns: number; tokens: TokenUsage; maxTurn: number };

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string | undefined => (typeof value === "string" && value ? value : undefined);
const zero = (): TokenUsage => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, reasoning: 0 });
const total = (tokens: TokenUsage): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
const add = (into: TokenUsage, from: TokenUsage): void => {
  into.input += from.input;
  into.output += from.output;
  into.cacheRead += from.cacheRead;
  into.cacheCreate += from.cacheCreate;
  into.reasoning = (into.reasoning ?? 0) + (from.reasoning ?? 0);
};
const cacheHit = (tokens: TokenUsage): number => {
  const read = tokens.input + tokens.cacheRead + tokens.cacheCreate;
  return read === 0 ? 0 : Math.round((tokens.cacheRead / read) * 1000) / 1000;
};
const isLongContext = (doc: SessionDoc): boolean => doc.model.includes("[1m]") || (doc.contextMax ?? 0) > 200_000;

function readSessions(db: Db): Map<string, SessionDoc> {
  const rows = db
    .statement(
      `SELECT key, json_extract(value,'$.title') title, json_extract(value,'$.driver') driver, json_extract(value,'$.model.model') model,
              json_extract(value,'$.model.effort') effort, json_extract(value,'$.projectId') project, json_extract(value,'$.startedFrom.sessionId') parent,
              json_extract(value,'$.createdAt') created, json_extract(value,'$.usage.contextUsed') used, json_extract(value,'$.usage.contextMax') max,
              json_extract(value,'$.purpose') purpose
         FROM documents WHERE key LIKE 'sessions/%/session.json'`,
    )
    .all();
  const sessions = new Map<string, SessionDoc>();
  for (const row of rows) {
    const id = String(row.key).split("/")[1]!;
    sessions.set(id, {
      id,
      title: str(row.title) ?? "",
      driver: str(row.driver) ?? "claude",
      model: str(row.model) ?? "default",
      ...(str(row.effort) ? { effort: str(row.effort)! } : {}),
      ...(str(row.project) ? { projectId: str(row.project)! } : {}),
      ...(str(row.parent) ? { parent: str(row.parent)! } : {}),
      createdAt: num(row.created),
      ...(row.used == null ? {} : { contextUsed: num(row.used) }),
      ...(row.max == null ? {} : { contextMax: num(row.max) }),
      ...(str(row.purpose) ? { purpose: str(row.purpose)! } : {}),
    });
  }
  return sessions;
}

function readTurns(db: Db, since: number): Row[] {
  return db
    .statement(
      `SELECT session_id, COALESCE(origin,'user') origin, COUNT(*) turns,
              SUM(COALESCE(usage_input,0)) i, SUM(COALESCE(usage_output,0)) o, SUM(COALESCE(usage_cache_read,0)) cr,
              SUM(COALESCE(usage_cache_create,0)) cc, SUM(COALESCE(usage_reasoning,0)) r,
              MAX(COALESCE(usage_input,0)+COALESCE(usage_output,0)+COALESCE(usage_cache_read,0)+COALESCE(usage_cache_create,0)) mx
         FROM turn_summaries WHERE ended_at >= ? AND usage_rows IS NOT NULL GROUP BY session_id, origin`,
    )
    .all(since)
    .map((row) => ({
      sessionId: String(row.session_id),
      origin: String(row.origin),
      turns: num(row.turns),
      tokens: { input: num(row.i), output: num(row.o), cacheRead: num(row.cr), cacheCreate: num(row.cc), reasoning: num(row.r) },
      maxTurn: num(row.mx),
    }));
}

type ItemCounts = { compactions: number; large: number; apiRetry: number; rateLimit: number; noResponse: number };

function readItemCounts(db: Db, sessionIds: string[], since: number): Map<string, ItemCounts> {
  const counts = new Map<string, ItemCounts>();
  if (sessionIds.length === 0) return counts;
  const marks = sessionIds.map(() => "?").join(",");
  const rows = db
    .statement(
      `SELECT i.session_id sid,
              SUM(i.value LIKE '%"type":"context_compaction"%') comp, SUM(length(i.value) > ${LARGE_ITEM_BYTES}) large,
              SUM(i.value LIKE '%"kind":"api_retry"%') retry, SUM(i.value LIKE '%"kind":"rate_limit"%') rate, SUM(i.value LIKE '%"kind":"no_response"%') silent
         FROM items i JOIN turn_summaries t ON t.session_id = i.session_id AND t.run_id = i.run_id
        WHERE i.session_id IN (${marks}) AND t.ended_at >= ? GROUP BY i.session_id`,
    )
    .all(...sessionIds, since);
  for (const row of rows) {
    counts.set(String(row.sid), { compactions: num(row.comp), large: num(row.large), apiRetry: num(row.retry), rateLimit: num(row.rate), noResponse: num(row.silent) });
  }
  return counts;
}

function readSchedules(db: Db, label:(sessionId: string) => string | undefined, turns: Row[]): UsageDigestSchedule[] {
  const scheduled = new Map<string, { runs: number; tokens: number }>();
  for (const row of turns) {
    if (row.origin !== "schedule") continue;
    const entry = scheduled.get(row.sessionId) ?? { runs: 0, tokens: 0 };
    entry.runs += row.turns;
    entry.tokens += total(row.tokens);
    scheduled.set(row.sessionId, entry);
  }
  return db
    .statement("SELECT session_id, rule, enabled FROM schedules")
    .all()
    .map((row) => {
      let rule: { kind?: string; everyMs?: number; weekdays?: number[] } = {};
      try {
        rule = JSON.parse(String(row.rule)) as typeof rule;
      } catch {}
      const periodMinutes = rule.kind === "interval" && rule.everyMs ? Math.round(rule.everyMs / 60_000) : rule.kind === "fixed" ? Math.round((7 * 1440) / Math.max(1, rule.weekdays?.length ?? 7)) : undefined;
      const sessionId = String(row.session_id);
      const ran = scheduled.get(sessionId) ?? { runs: 0, tokens: 0 };
      const session = label(sessionId);
      return { ...(session ? { session } : {}), ...(periodMinutes ? { periodMinutes } : {}), enabled: Boolean(row.enabled), runs: ran.runs, tokens: ran.tokens };
    });
}

function rootOf(id: string, sessions: Map<string, SessionDoc>): { root: string; depth: number } {
  let current = id;
  let depth = 0;
  const seen = new Set<string>();
  while (sessions.get(current)?.parent && !seen.has(current) && sessions.has(sessions.get(current)!.parent!)) {
    seen.add(current);
    current = sessions.get(current)!.parent!;
    depth += 1;
  }
  return { root: current, depth };
}

/** Aggregates only: sessions become `s1…sN` and projects `p1…pN`; `names` maps them back for local display. */
export function buildUsageDigest(input: DigestInput): { digest: UsageDigest; names: Record<string, string> } {
  const { db, now, rates } = input;
  const sessions = readSessions(db);
  const keep = (id: string) => !input.exclude?.(id) && sessions.get(id)?.purpose === undefined;
  const turns30 = readTurns(db, now - WINDOWS["30d"]).filter((row) => keep(row.sessionId));
  const price = (id: string, tokens: TokenUsage) => priceTokens(rates, sessions.get(id)?.model ?? "default", tokens) ?? 0;

  const perSession = new Map<string, { tokens: TokenUsage; turns: number; maxTurn: number; origins: Record<string, number> }>();
  for (const row of turns30) {
    const entry = perSession.get(row.sessionId) ?? { tokens: zero(), turns: 0, maxTurn: 0, origins: {} };
    add(entry.tokens, row.tokens);
    entry.turns += row.turns;
    entry.maxTurn = Math.max(entry.maxTurn, row.maxTurn);
    entry.origins[row.origin] = (entry.origins[row.origin] ?? 0) + row.turns;
    perSession.set(row.sessionId, entry);
  }
  const ranked = [...perSession.entries()].sort((a, b) => total(b[1].tokens) - total(a[1].tokens));
  const anon = new Map(ranked.map(([id], index) => [id, `s${index + 1}`]));
  const projects = new Map<string, string>();
  const names: Record<string, string> = {};
  const projectLabel = (projectId: string | undefined) => {
    if (!projectId) return undefined;
    if (!projects.has(projectId)) {
      const label = `p${projects.size + 1}`;
      projects.set(projectId, label);
      names[label] = input.projectName(projectId) ?? label;
    }
    return projects.get(projectId);
  };
  const label = (id: string) => anon.get(id);

  const windows = {} as UsageDigest["windows"];
  for (const [window, span] of Object.entries(WINDOWS) as Array<[UsageDigestWindow, number]>) {
    const rows = window === "30d" ? turns30 : readTurns(db, now - span).filter((row) => keep(row.sessionId));
    const tokens = zero();
    const byModel = new Map<string, { model: string; tokens: number; costUsd: number; turns: number }>();
    let costUsd = 0;
    let turnCount = 0;
    for (const row of rows) {
      add(tokens, row.tokens);
      turnCount += row.turns;
      const cost = price(row.sessionId, row.tokens);
      costUsd += cost;
      const model = sessions.get(row.sessionId)?.model ?? "default";
      const entry = byModel.get(model) ?? { model, tokens: 0, costUsd: 0, turns: 0 };
      entry.tokens += total(row.tokens);
      entry.costUsd += cost;
      entry.turns += row.turns;
      byModel.set(model, entry);
    }
    const totals: UsageDigestTotals = { tokens, costUsd: round(costUsd), turns: turnCount, sessions: new Set(rows.map((row) => row.sessionId)).size, cacheHit: cacheHit(tokens) };
    windows[window] = { totals, byModel: [...byModel.values()].map((entry) => ({ ...entry, costUsd: round(entry.costUsd) })).sort((a, b) => b.tokens - a.tokens) };
  }

  const top = ranked.slice(0, TOP_SESSIONS);
  const items = readItemCounts(db, top.map(([id]) => id), now - WINDOWS["30d"]);
  const topSessions: UsageDigestSession[] = top.map(([id, entry]) => {
    const doc = sessions.get(id);
    const counts = items.get(id);
    const anonId = anon.get(id)!;
    names[anonId] = doc?.title || anonId;
    const project = projectLabel(doc?.projectId);
    const parent = doc?.parent ? label(doc.parent) : undefined;
    return {
      id: anonId,
      ...(project ? { project } : {}),
      driver: doc?.driver ?? "claude",
      model: doc?.model ?? "default",
      ...(doc?.effort ? { effort: doc.effort } : {}),
      longContext: doc ? isLongContext(doc) : false,
      tokens: entry.tokens,
      costUsd: round(price(id, entry.tokens)),
      turns: entry.turns,
      avgTokensPerTurn: Math.round(total(entry.tokens) / Math.max(1, entry.turns)),
      maxTokensPerTurn: entry.maxTurn,
      ...(doc?.contextUsed === undefined ? {} : { contextUsed: doc.contextUsed }),
      ...(doc?.contextMax === undefined ? {} : { contextMax: doc.contextMax }),
      origins: entry.origins,
      compactions: counts?.compactions ?? 0,
      largeToolOutputs: counts?.large ?? 0,
      providerWaits: { apiRetry: counts?.apiRetry ?? 0, rateLimit: counts?.rateLimit ?? 0, noResponse: counts?.noResponse ?? 0 },
      ...(parent ? { startedBy: parent } : {}),
      ageDays: doc?.createdAt ? Math.floor((now - doc.createdAt) / DAY_MS) : 0,
    };
  });

  const trees = new Map<string, UsageDigestTree & { members: Set<string> }>();
  for (const [id, entry] of perSession) {
    const { root, depth } = rootOf(id, sessions);
    const tree = trees.get(root) ?? { root, sessions: 0, depth: 0, tokens: 0, costUsd: 0, models: {}, members: new Set<string>() };
    tree.members.add(id);
    tree.sessions = tree.members.size;
    tree.depth = Math.max(tree.depth, depth);
    tree.tokens += total(entry.tokens);
    tree.costUsd += price(id, entry.tokens);
    const model = sessions.get(id)?.model ?? "default";
    tree.models[model] = (tree.models[model] ?? 0) + total(entry.tokens);
    trees.set(root, tree);
  }
  const fanOut = [...trees.values()]
    .filter((tree) => tree.sessions > 1)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 10)
    .map(({ members: _members, ...tree }) => ({ ...tree, root: label(tree.root) ?? "other", costUsd: round(tree.costUsd) }));

  const contextHistogram = { under50k: 0, "50kTo200k": 0, "200kTo1m": 0, over1m: 0 };
  for (const id of perSession.keys()) {
    const used = sessions.get(id)?.contextUsed;
    if (used === undefined) continue;
    if (used < 50_000) contextHistogram.under50k += 1;
    else if (used < 200_000) contextHistogram["50kTo200k"] += 1;
    else if (used < 1_000_000) contextHistogram["200kTo1m"] += 1;
    else contextHistogram.over1m += 1;
  }

  const schedules = readSchedules(db, label, turns30);
  const byDriver = new Map<string, number>();
  for (const [id, entry] of perSession) {
    const driver = sessions.get(id)?.driver ?? "claude";
    byDriver.set(driver, (byDriver.get(driver) ?? 0) + total(entry.tokens));
  }
  const providerLogs = input.providerLogs.map((entry) => ({ ...entry, costUsd: round(entry.costUsd), telarTokens: byDriver.get(entry.provider) ?? 0 }));
  const digest: UsageDigest = { version: 1, createdAt: now, windows, providerLogs, topSessions, trees: fanOut, schedules, contextHistogram, config: input.config, signals: [] };
  digest.signals = usageSignals(digest);
  return { digest, names };
}

const round = (value: number): number => Math.round(value * 100) / 100;
