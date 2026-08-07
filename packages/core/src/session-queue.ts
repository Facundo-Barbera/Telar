// Durable, engine-owned pending turns for one chat session.
//
// The renderer may disappear at any time. Once enqueueSessionTurn returns, the
// complete JSON payload and its idempotency identity live under
// `<TELAR_HOME>/sessions/<sessionId>/queue.json`; React is only a projection of
// this state. Mutations are synchronous read-modify-atomic-rename operations,
// so one Node process cannot expose a half-written envelope. Cross-process
// dispatch ownership is provided by the session lease in sessions.ts.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { sessionDir } from "./sessions";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export type SessionQueueState =
  | "queued"
  | "claimed"
  | "running"
  | "committed"
  | "failed"
  | "cancelled"
  | "ambiguous";

export type SessionQueueItem<T extends JsonValue = JsonValue> = {
  /** Stable client identity. It is never replaced, including after adoption. */
  idempotencyKey: string;
  /** Optional engine/provider identity learned after acceptance. */
  canonicalKey?: string;
  sequence: number;
  revision: number;
  state: SessionQueueState;
  payload: T;
  acceptedAt: number;
  updatedAt: number;
  claim?: { token: string; by: string; at: number };
  startedAt?: number;
  settledAt?: number;
  error?: string;
};

export type SessionQueueEnvelope<T extends JsonValue = JsonValue> = {
  schemaVersion: 1;
  sessionId: string;
  revision: number;
  nextSequence: number;
  paused: boolean;
  items: SessionQueueItem<T>[];
};

export type EnqueueSessionTurn<T extends JsonValue> = {
  idempotencyKey: string;
  payload: T;
  canonicalKey?: string;
};

export type ClaimedSessionTurn<T extends JsonValue = JsonValue> = {
  item: SessionQueueItem<T>;
  claimToken: string;
};

export type SessionQueueRecovery = {
  requeued: string[];
  ambiguous: string[];
  envelope: SessionQueueEnvelope;
};

const FILE = "queue.json";
const VALID_STATES = new Set<SessionQueueState>([
  "queued",
  "claimed",
  "running",
  "committed",
  "failed",
  "cancelled",
  "ambiguous",
]);

const nowDefault = () => Date.now();

export class SessionQueueConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionQueueConflictError";
  }
}

export class SessionQueueCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionQueueCorruptError";
  }
}

export const sessionQueueFile = (sessionId: string): string =>
  path.join(sessionDir(sessionId), FILE);

/** Queue-owning discovery used only by server boot recovery. */
export function listSessionQueueIds(): string[] {
  const root = path.dirname(sessionDir("discovery-probe"));
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isDirectory() && /^[A-Za-z0-9_-]+$/.test(entry.name))
    .map((entry) => entry.name)
    .filter((sessionId) => fs.existsSync(sessionQueueFile(sessionId)))
    .sort();
}

const emptyEnvelope = <T extends JsonValue>(sessionId: string): SessionQueueEnvelope<T> => ({
  schemaVersion: 1,
  sessionId,
  revision: 0,
  nextSequence: 0,
  paused: false,
  items: [],
});

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SessionQueueConflictError(`${label} must be a non-empty string`);
  }
}

function assertJson(value: unknown, at = "payload", seen = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new SessionQueueConflictError(`${at} contains a non-finite number`);
  }
  if (typeof value !== "object") {
    throw new SessionQueueConflictError(`${at} is not complete JSON`);
  }
  if (seen.has(value)) throw new SessionQueueConflictError(`${at} contains a cycle`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new SessionQueueConflictError(`${at} contains a sparse array slot`);
      assertJson(value[index], `${at}[${index}]`, seen);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SessionQueueConflictError(`${at} contains a non-JSON object`);
    }
    for (const [key, entry] of Object.entries(value)) assertJson(entry, `${at}.${key}`, seen);
  }
  seen.delete(value);
}

function validateEnvelope<T extends JsonValue>(sessionId: string, value: unknown): SessionQueueEnvelope<T> {
  const e = value as Partial<SessionQueueEnvelope<T>> | null;
  if (
    !e ||
    e.schemaVersion !== 1 ||
    e.sessionId !== sessionId ||
    !Number.isSafeInteger(e.revision) ||
    (e.revision ?? -1) < 0 ||
    !Number.isSafeInteger(e.nextSequence) ||
    (e.nextSequence ?? -1) < 0 ||
    typeof e.paused !== "boolean" ||
    !Array.isArray(e.items)
  ) {
    throw new SessionQueueCorruptError(`invalid session queue envelope for ${JSON.stringify(sessionId)}`);
  }
  const identities = new Set<string>();
  let priorSequence = -1;
  for (const item of e.items) {
    if (
      !item ||
      typeof item.idempotencyKey !== "string" ||
      item.idempotencyKey === "" ||
      (item.canonicalKey !== undefined &&
        (typeof item.canonicalKey !== "string" || item.canonicalKey === "")) ||
      !Number.isSafeInteger(item.sequence) ||
      item.sequence < 0 ||
      item.sequence <= priorSequence ||
      !Number.isSafeInteger(item.revision) ||
      item.revision < 0 ||
      !VALID_STATES.has(item.state) ||
      !Number.isFinite(item.acceptedAt) ||
      !Number.isFinite(item.updatedAt)
    ) {
      throw new SessionQueueCorruptError(`invalid session queue item for ${JSON.stringify(sessionId)}`);
    }
    try {
      assertJson(item.payload);
    } catch (error) {
      throw new SessionQueueCorruptError(
        `invalid payload in session queue ${JSON.stringify(sessionId)}: ${String(error)}`,
      );
    }
    priorSequence = item.sequence;
    for (const key of [item.idempotencyKey, item.canonicalKey]) {
      if (!key) continue;
      if (identities.has(key)) {
        throw new SessionQueueCorruptError(`duplicate queue identity ${JSON.stringify(key)}`);
      }
      identities.add(key);
    }
  }
  return e as SessionQueueEnvelope<T>;
}

export function readSessionQueue<T extends JsonValue = JsonValue>(
  sessionId: string,
): SessionQueueEnvelope<T> {
  let raw: string;
  try {
    raw = fs.readFileSync(sessionQueueFile(sessionId), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyEnvelope<T>(sessionId);
    throw error;
  }
  try {
    return validateEnvelope<T>(sessionId, JSON.parse(raw));
  } catch (error) {
    if (error instanceof SessionQueueCorruptError) throw error;
    throw new SessionQueueCorruptError(
      `cannot parse session queue for ${JSON.stringify(sessionId)}: ${String(error)}`,
    );
  }
}

function writeEnvelope<T extends JsonValue>(envelope: SessionQueueEnvelope<T>): void {
  const dir = sessionDir(envelope.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const file = sessionQueueFile(envelope.sessionId);
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(envelope));
    fs.renameSync(tmp, file);
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function copyItem<T extends JsonValue>(item: SessionQueueItem<T>): SessionQueueItem<T> {
  return structuredClone(item);
}

function findByKey<T extends JsonValue>(
  envelope: SessionQueueEnvelope<T>,
  key: string,
): SessionQueueItem<T> | undefined {
  return envelope.items.find((item) => item.idempotencyKey === key || item.canonicalKey === key);
}

function mutate<T extends JsonValue, R>(
  sessionId: string,
  fn: (envelope: SessionQueueEnvelope<T>) => { changed: boolean; result: R },
): R {
  const envelope = readSessionQueue<T>(sessionId);
  const { changed, result } = fn(envelope);
  if (changed) {
    envelope.revision += 1;
    writeEnvelope(envelope);
  }
  return result;
}

function assertItemRevision<T extends JsonValue>(
  item: SessionQueueItem<T>,
  expectedRevision: number,
): void {
  if (item.revision !== expectedRevision) {
    throw new SessionQueueConflictError(
      `queue item revision conflict: expected ${expectedRevision}, found ${item.revision}`,
    );
  }
}

function touch<T extends JsonValue>(item: SessionQueueItem<T>, at: number): void {
  item.revision += 1;
  item.updatedAt = at;
}

export function enqueueSessionTurn<T extends JsonValue>(
  sessionId: string,
  input: EnqueueSessionTurn<T>,
  now: () => number = nowDefault,
): SessionQueueItem<T> {
  nonEmpty(input.idempotencyKey, "idempotencyKey");
  if (input.canonicalKey !== undefined) nonEmpty(input.canonicalKey, "canonicalKey");
  assertJson(input.payload);
  const canonicalKey =
    input.canonicalKey && input.canonicalKey !== input.idempotencyKey
      ? input.canonicalKey
      : undefined;
  return mutate<T, SessionQueueItem<T>>(sessionId, (envelope) => {
    const duplicate = findByKey(envelope, input.idempotencyKey);
    if (duplicate) return { changed: false, result: copyItem(duplicate) };
    if (canonicalKey) {
      const canonicalDuplicate = findByKey(envelope, canonicalKey);
      if (canonicalDuplicate) return { changed: false, result: copyItem(canonicalDuplicate) };
    }
    const at = now();
    const item: SessionQueueItem<T> = {
      idempotencyKey: input.idempotencyKey,
      ...(canonicalKey ? { canonicalKey } : {}),
      sequence: envelope.nextSequence++,
      revision: 0,
      state: "queued",
      payload: structuredClone(input.payload),
      acceptedAt: at,
      updatedAt: at,
    };
    envelope.items.push(item);
    return { changed: true, result: copyItem(item) };
  });
}

export function adoptSessionTurnCanonicalKey<T extends JsonValue = JsonValue>(
  sessionId: string,
  key: string,
  canonicalKey: string,
  expectedRevision: number,
  now: () => number = nowDefault,
): SessionQueueItem<T> {
  nonEmpty(key, "key");
  nonEmpty(canonicalKey, "canonicalKey");
  return mutate<T, SessionQueueItem<T>>(sessionId, (envelope) => {
    const item = findByKey(envelope, key);
    if (!item) throw new SessionQueueConflictError(`unknown queue item ${JSON.stringify(key)}`);
    assertItemRevision(item, expectedRevision);
    // The stable key already IS this identity. Storing the same string in both
    // fields would create two names for no new information and violate the
    // envelope's global uniqueness invariant.
    if (canonicalKey === item.idempotencyKey) {
      return { changed: false, result: copyItem(item) };
    }
    const owner = findByKey(envelope, canonicalKey);
    if (owner && owner !== item) {
      throw new SessionQueueConflictError(`canonical key ${JSON.stringify(canonicalKey)} is already owned`);
    }
    if (item.canonicalKey === canonicalKey) return { changed: false, result: copyItem(item) };
    item.canonicalKey = canonicalKey;
    touch(item, now());
    return { changed: true, result: copyItem(item) };
  });
}

export function editQueuedSessionTurn<T extends JsonValue>(
  sessionId: string,
  key: string,
  payload: T,
  expectedRevision: number,
  now: () => number = nowDefault,
): SessionQueueItem<T> {
  assertJson(payload);
  return mutate<T, SessionQueueItem<T>>(sessionId, (envelope) => {
    const item = findByKey(envelope, key);
    if (!item) throw new SessionQueueConflictError(`unknown queue item ${JSON.stringify(key)}`);
    assertItemRevision(item, expectedRevision);
    if (item.state !== "queued") {
      throw new SessionQueueConflictError(`only queued items may be edited; found ${item.state}`);
    }
    item.payload = structuredClone(payload);
    touch(item, now());
    return { changed: true, result: copyItem(item) };
  });
}

export function cancelQueuedSessionTurn<T extends JsonValue = JsonValue>(
  sessionId: string,
  key: string,
  expectedRevision: number,
  now: () => number = nowDefault,
): SessionQueueItem<T> {
  return mutate<T, SessionQueueItem<T>>(sessionId, (envelope) => {
    const item = findByKey(envelope, key);
    if (!item) throw new SessionQueueConflictError(`unknown queue item ${JSON.stringify(key)}`);
    assertItemRevision(item, expectedRevision);
    if (item.state !== "queued") {
      throw new SessionQueueConflictError(`only queued items may be cancelled; found ${item.state}`);
    }
    item.state = "cancelled";
    item.settledAt = now();
    touch(item, item.settledAt);
    return { changed: true, result: copyItem(item) };
  });
}

/**
 * A HUMAN DISMISSING A MESSAGE THE ENGINE WILL NEVER RETRY.
 *
 * `failed` and `ambiguous` are the two settled states nothing transitions out
 * of: the dispatcher settles the item and pauses the queue behind it, so the
 * item stays in the envelope for as long as the session exists. The renderer
 * has to show it — a message that did not send may not vanish — and until now
 * had no way to ever stop showing it, because the only removal path is
 * `cancelQueuedSessionTurn`, which correctly refuses anything but `queued`.
 *
 * DELIBERATELY NOT A WIDENING OF THAT FUNCTION. Retracting a queued message is
 * a claim that nothing happened; acknowledging a failed one is not, and
 * `ambiguous` means specifically "this may already have reached the provider".
 * Two names force the caller to say which it means, and leave "only queued
 * items may be cancelled" true. Dismissing an AMBIGUOUS item is also what
 * releases the claim barrier it holds (see claimNextSessionTurn) — the human
 * answered the message's question, which is the only "resume" that exists.
 */
export function dismissFailedSessionTurn<T extends JsonValue = JsonValue>(
  sessionId: string,
  key: string,
  expectedRevision: number,
  now: () => number = nowDefault,
): SessionQueueItem<T> {
  return mutate<T, SessionQueueItem<T>>(sessionId, (envelope) => {
    const item = findByKey(envelope, key);
    if (!item) throw new SessionQueueConflictError(`unknown queue item ${JSON.stringify(key)}`);
    assertItemRevision(item, expectedRevision);
    if (item.state !== "failed" && item.state !== "ambiguous") {
      throw new SessionQueueConflictError(
        `only failed or ambiguous items may be dismissed; found ${item.state}`,
      );
    }
    item.state = "cancelled";
    item.settledAt = now();
    // `error` is kept: the item is history now, and history that drops the
    // reason it exists is worse than no history.
    touch(item, item.settledAt);
    return { changed: true, result: copyItem(item) };
  });
}

export function setSessionQueuePaused(
  sessionId: string,
  paused: boolean,
): SessionQueueEnvelope {
  mutate(sessionId, (envelope) => {
    if (envelope.paused === paused) return { changed: false, result: undefined };
    envelope.paused = paused;
    return { changed: true, result: undefined };
  });
  return readSessionQueue(sessionId);
}

export const pauseSessionQueue = (sessionId: string): SessionQueueEnvelope =>
  setSessionQueuePaused(sessionId, true);

export const resumeSessionQueue = (sessionId: string): SessionQueueEnvelope =>
  setSessionQueuePaused(sessionId, false);

export function claimNextSessionTurn<T extends JsonValue = JsonValue>(
  sessionId: string,
  claimedBy: string,
  now: () => number = nowDefault,
): ClaimedSessionTurn<T> | null {
  nonEmpty(claimedBy, "claimedBy");
  return mutate<T, ClaimedSessionTurn<T> | null>(sessionId, (envelope) => {
    if (envelope.paused) return { changed: false, result: null };
    if (envelope.items.some((item) => item.state === "claimed" || item.state === "running")) {
      return { changed: false, result: null };
    }
    // An unanswered AMBIGUOUS item (the engine died while it ran — it may
    // have already changed the workspace) holds claiming until the human
    // answers Retry or Discard ON THAT MESSAGE. This is the barrier that
    // used to be `envelope.paused = true` at recovery: same safety, scoped
    // to the one message that earned it, with no session mode and no Resume
    // button (feel contract rule 13).
    if (envelope.items.some((item) => item.state === "ambiguous")) {
      return { changed: false, result: null };
    }
    const item = envelope.items.find((candidate) => candidate.state === "queued");
    if (!item) return { changed: false, result: null };
    const at = now();
    const claimToken = crypto.randomUUID();
    item.state = "claimed";
    item.claim = { token: claimToken, by: claimedBy, at };
    touch(item, at);
    return { changed: true, result: { item: copyItem(item), claimToken } };
  });
}

function transitionClaimed<T extends JsonValue>(
  sessionId: string,
  key: string,
  claimToken: string,
  from: SessionQueueState[],
  to: SessionQueueState,
  now: () => number,
  error?: string,
): SessionQueueItem<T> {
  nonEmpty(claimToken, "claimToken");
  return mutate<T, SessionQueueItem<T>>(sessionId, (envelope) => {
    const item = findByKey(envelope, key);
    if (!item) throw new SessionQueueConflictError(`unknown queue item ${JSON.stringify(key)}`);
    if (!from.includes(item.state)) {
      throw new SessionQueueConflictError(`cannot transition ${item.state} to ${to}`);
    }
    if (item.claim?.token !== claimToken) throw new SessionQueueConflictError("claim token mismatch");
    const at = now();
    item.state = to;
    if (to === "running") item.startedAt = at;
    if (["committed", "failed", "cancelled", "ambiguous"].includes(to)) item.settledAt = at;
    if (error !== undefined) item.error = error;
    touch(item, at);
    return { changed: true, result: copyItem(item) };
  });
}

export function markSessionTurnRunning<T extends JsonValue = JsonValue>(
  sessionId: string,
  key: string,
  claimToken: string,
  now: () => number = nowDefault,
): SessionQueueItem<T> {
  return transitionClaimed(sessionId, key, claimToken, ["claimed"], "running", now);
}

export function commitSessionTurn<T extends JsonValue = JsonValue>(
  sessionId: string,
  key: string,
  claimToken: string,
  now: () => number = nowDefault,
): SessionQueueItem<T> {
  return transitionClaimed(sessionId, key, claimToken, ["running"], "committed", now);
}

export function failSessionTurn<T extends JsonValue = JsonValue>(
  sessionId: string,
  key: string,
  claimToken: string,
  error: string,
  now: () => number = nowDefault,
): SessionQueueItem<T> {
  return transitionClaimed(sessionId, key, claimToken, ["claimed", "running"], "failed", now, error);
}

export function recoverSessionQueue(
  sessionId: string,
  now: () => number = nowDefault,
): SessionQueueRecovery {
  const requeued: string[] = [];
  const ambiguous: string[] = [];
  mutate(sessionId, (envelope) => {
    const at = now();
    for (const item of envelope.items) {
      if (item.state === "claimed") {
        item.state = "queued";
        delete item.claim;
        touch(item, at);
        requeued.push(item.idempotencyKey);
      } else if (item.state === "running") {
        item.state = "ambiguous";
        item.error =
          "Wasn't sent — the server restarted while this was running. It may have already made changes.";
        item.settledAt = at;
        touch(item, at);
        ambiguous.push(item.idempotencyKey);
      }
    }
    // Uncertain provider/tool effects still bar later items — but the barrier
    // lives in claimNextSessionTurn's ambiguous guard, scoped to the message,
    // never as a session-level paused mode demanding a Resume click.
    return { changed: requeued.length > 0 || ambiguous.length > 0, result: undefined };
  });
  return { requeued, ambiguous, envelope: readSessionQueue(sessionId) };
}
