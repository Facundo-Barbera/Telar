/**
 * REMEMBERED LOGIN AUTHORIZATIONS — the record that lets a later
 * `browser_fill_secret` skip Telar's approval card, and nothing else.
 *
 * WHAT A GRANT IS. One human, once, ticked "allow agents to use this login
 * automatically" on a fill they were already approving. What that produced is
 * this record: an exact BROWSER PROFILE, an exact ORIGIN, an exact VAULT ITEM,
 * and the exact FIELD KINDS they saw named on the card. All four are matched
 * exactly on the remembered path — there is no title match, no
 * first-candidate fallback, no registrable-domain widening, no "any item in
 * that vault". A request that differs in any of them is not this grant and
 * asks a human again.
 *
 * WHAT A GRANT IS NOT:
 *   - not a key, and not a secret: no value ever enters this file, and the
 *     record is safe in a state directory. What it stores is a POINTER a
 *     person authorized, exactly as `secret_access` details already do;
 *   - not a bypass of 1Password: `op` still enforces the vault's own lock and
 *     biometric policy on every read, and a locked vault fails the fill;
 *   - not inferred. Nothing in this module observes a login and concludes a
 *     grant; the only writer is an explicit tick on an approval card;
 *   - not a widening of any other approval. `secret_access` remains the one
 *     request kind `autoResolution` refuses in every runtime mode — a grant
 *     answers ONE request shape, not the kind.
 *
 * TWO PROCESSES READ THIS FILE (the daemon serves the settings list; the worker
 * matches during a fill), so nothing is cached: every call reads, and every
 * write is atomic and 0600.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretFieldKind } from "@telar/engine-client";

export const LOGIN_GRANTS_VERSION = 1;
export const LOGIN_GRANTS_FILE = "browser-login-grants.json";

/** One approved field: a kind, plus the exact 1Password field label when the
 *  kind is the open-ended `field`. */
export type GrantField = { kind: SecretFieldKind; label?: string };

export type LoginGrant = {
  id: string;
  /** The browser profile the fill may happen in — a desktop profile id, or a
   *  headless scope's own identity. Never a project. */
  profileId: string;
  /** Shown in the settings list so a person recognises what they allowed. */
  profileLabel?: string;
  /** EXACT origin, scheme included: `https://mail.example.com`. A grant for one
   *  origin says nothing about another host of the same registrable domain. */
  origin: string;
  itemId: string;
  itemTitle: string;
  vault?: string;
  /** Exactly the field kinds the human saw named on the card. A later fill
   *  asking for MORE (a one-time code where only a password was approved) does
   *  not match. */
  fields: GrantField[];
  createdAt: number;
  lastUsedAt?: number;
};

export type LoginGrantStore = {
  list(): LoginGrant[];
  /** The grant that authorizes exactly this fill, or null. With no `itemId`
   *  this is only meaningful when `findAll` returns one — see the note there. */
  find(input: { profileId: string; origin: string; itemId?: string; wants: readonly GrantField[] }): LoginGrant | null;
  /**
   * EVERY grant that covers this profile, origin and field set.
   *
   * The caller picks, and must pick UNAMBIGUOUSLY: two authorized accounts on
   * one site is the case named profiles exist for, and choosing one of them
   * here — by order, by recency, by anything — would be this feature quietly
   * signing a person into the wrong account. When more than one comes back and
   * nothing selects between them, the answer is to ask.
   */
  findAll(input: { profileId: string; origin: string; wants: readonly GrantField[] }): LoginGrant[];
  remember(input: Omit<LoginGrant, "id" | "createdAt">): LoginGrant;
  touch(id: string): void;
  revoke(id: string): boolean;
};

function sameField(a: GrantField, b: GrantField): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "field") return true;
  // A labelled field is only the same field under the same label, compared the
  // way `op` matches one (case-insensitively).
  return (a.label ?? "").trim().toLowerCase() === (b.label ?? "").trim().toLowerCase();
}

/** An origin string is only usable if it IS an origin: scheme + host, http(s),
 *  no path. Anything else never becomes a grant. */
export function exactOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

function parse(raw: unknown): LoginGrant[] {
  if (!raw || typeof raw !== "object") return [];
  const document = raw as { version?: unknown; grants?: unknown };
  if (document.version !== LOGIN_GRANTS_VERSION || !Array.isArray(document.grants)) return [];
  const grants: LoginGrant[] = [];
  for (const entry of document.grants) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : "";
    const profileId = typeof record.profileId === "string" ? record.profileId : "";
    const origin = typeof record.origin === "string" ? exactOrigin(record.origin) : null;
    const itemId = typeof record.itemId === "string" ? record.itemId : "";
    const itemTitle = typeof record.itemTitle === "string" ? record.itemTitle : "";
    const fields = Array.isArray(record.fields) ? record.fields : [];
    const parsedFields: GrantField[] = [];
    for (const field of fields) {
      const shape = field as { kind?: unknown; label?: unknown };
      if (shape.kind !== "username" && shape.kind !== "password" && shape.kind !== "otp" && shape.kind !== "field") continue;
      // A `field` grant with no label could match any label; refuse it whole.
      if (shape.kind === "field" && typeof shape.label !== "string") continue;
      parsedFields.push({ kind: shape.kind, ...(typeof shape.label === "string" ? { label: shape.label } : {}) });
    }
    if (!id || !profileId || !origin || !itemId || parsedFields.length === 0) continue;
    grants.push({
      id,
      profileId,
      ...(typeof record.profileLabel === "string" ? { profileLabel: record.profileLabel } : {}),
      origin,
      itemId,
      itemTitle: itemTitle || itemId,
      ...(typeof record.vault === "string" ? { vault: record.vault } : {}),
      fields: parsedFields,
      createdAt: typeof record.createdAt === "number" ? record.createdAt : 0,
      ...(typeof record.lastUsedAt === "number" ? { lastUsedAt: record.lastUsedAt } : {}),
    });
  }
  return grants;
}

/**
 * The store, over one file in the engine's state directory. `now` and `mintId`
 * are injected by tests; nothing else about this is configurable.
 */
/**
 * THE CROSS-PROCESS LOCK, and why an atomic rename is not enough on its own.
 *
 * Two processes mutate this file: the daemon (a person revoking in settings)
 * and whichever worker is running a fill (remember, touch). Each mutation is a
 * read-modify-write, and an atomic rename only makes each WRITE indivisible —
 * it does nothing about a revoke that lands between another process's read and
 * its write, which would put the revoked grant straight back.
 *
 * `mkdir` is the primitive: it is atomic and fails if the directory exists, on
 * every filesystem that matters here, with no O_EXCL-over-NFS caveats. The wait
 * is a real sleep (`Atomics.wait` on a throwaway buffer) because these stores
 * are synchronous by design — the callers are a settings route and a
 * credential path, both of which want the answer before they continue.
 *
 * A lock older than `STALE_LOCK_MS` is broken: a process that died holding it
 * must not stop a person from revoking a credential authorization, and the
 * worst case of breaking one is the ordinary lost-update race we already had.
 */
const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 15;
const LOCK_ATTEMPTS = 400; // ~6 s of contention before giving up on a live holder

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function withFileLock<T>(lockPath: string, run: () => T): T {
  let held = false;
  for (let attempt = 0; attempt < LOCK_ATTEMPTS && !held; attempt += 1) {
    try {
      fs.mkdirSync(lockPath);
      held = true;
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error;
      let age = 0;
      try {
        age = Date.now() - fs.statSync(lockPath).mtimeMs;
      } catch {
        continue; // it was released between the mkdir and the stat
      }
      if (age > STALE_LOCK_MS) {
        try { fs.rmdirSync(lockPath); } catch { /* someone else broke it first */ }
        continue;
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  if (!held) throw new Error("Could not take the browser login grant lock.");
  try {
    return run();
  } finally {
    try { fs.rmdirSync(lockPath); } catch { /* already broken as stale */ }
  }
}

export function createLoginGrantStore(
  stateRoot: string,
  { now = Date.now, mintId = () => `lg_${crypto.randomBytes(8).toString("hex")}` } = {},
): LoginGrantStore {
  const file = path.join(stateRoot, LOGIN_GRANTS_FILE);
  const lock = `${file}.lock`;

  const read = (): LoginGrant[] => {
    try {
      return parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if (error && (error as { code?: string }).code === "ENOENT") return [];
      // An unreadable file authorizes NOTHING — it never falls back to "allow".
      console.error(`[engine] ignoring an unreadable browser login grant file: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };

  const write = (grants: LoginGrant[]): void => {
    fs.mkdirSync(stateRoot, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: LOGIN_GRANTS_VERSION, grants }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
    // A file that predates the mode above (or an inherited umask) is corrected.
    try { fs.chmodSync(file, 0o600); } catch { /* a filesystem without modes */ }
  };

  /** Every mutation, and only a mutation, runs here: the state directory has
   *  to exist before a lock can be taken in it, and the lock has to cover the
   *  whole read-modify-write. Reads stay lock-free — a reader either sees the
   *  file before a rename or after it, never during. */
  const mutate = <T>(run: () => T): T => {
    fs.mkdirSync(stateRoot, { recursive: true });
    return withFileLock(lock, run);
  };

  const matches = (grant: LoginGrant, profileId: string, exact: string, wants: readonly GrantField[]): boolean =>
    grant.profileId === profileId &&
    grant.origin === exact &&
    // EVERY wanted field must be one the human approved. Subset, not overlap:
    // an extra kind is a different authorization.
    wants.every((want) => grant.fields.some((field) => sameField(field, want)));

  return {
    list: () => read().sort((a, b) => b.createdAt - a.createdAt),

    findAll({ profileId, origin, wants }) {
      const exact = exactOrigin(origin);
      if (!exact || !profileId || wants.length === 0) return [];
      return read().filter((grant) => matches(grant, profileId, exact, wants));
    },

    find({ profileId, origin, itemId, wants }) {
      const exact = exactOrigin(origin);
      if (!exact || !profileId || wants.length === 0) return null;
      const found = read().filter((grant) => matches(grant, profileId, exact, wants) && (itemId === undefined || grant.itemId === itemId));
      // Without an item to pin, an ambiguous answer is NO answer — see
      // `findAll`. With one, the (profile, origin, item) key is unique.
      return found.length === 1 ? found[0]! : null;
    },

    remember(input) {
      const origin = exactOrigin(input.origin);
      if (!origin) throw new Error("A remembered login needs an exact http(s) origin.");
      if (!input.profileId) throw new Error("A remembered login needs the browser profile it applies to.");
      if (!input.itemId) throw new Error("A remembered login needs the 1Password item the human picked.");
      if (!input.fields.length) throw new Error("A remembered login needs the fields the human approved.");
      return mutate(() => {
        const grants = read();
        const grant: LoginGrant = { ...input, origin, id: mintId(), createdAt: now() };
        // One grant per (profile, origin, item): re-approving replaces rather
        // than accumulating, so the settings list stays the truth.
        const kept = grants.filter(
          (existing) => !(existing.profileId === grant.profileId && existing.origin === grant.origin && existing.itemId === grant.itemId),
        );
        write([...kept, grant]);
        return grant;
      });
    },

    touch(id) {
      mutate(() => {
        const grants = read();
        const found = grants.find((grant) => grant.id === id);
        // Re-read INSIDE the lock: a revoke that landed while this fill was
        // running means there is nothing to touch, and writing the old list
        // back would resurrect the grant the person just took away.
        if (!found) return;
        found.lastUsedAt = now();
        write(grants);
      });
    },

    revoke(id) {
      return mutate(() => {
        const grants = read();
        const kept = grants.filter((grant) => grant.id !== id);
        if (kept.length === grants.length) return false;
        write(kept);
        return true;
      });
    },
  };
}
