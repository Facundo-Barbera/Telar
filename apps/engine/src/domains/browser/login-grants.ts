import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretFieldKind } from "@telar/engine-client";

export const LOGIN_GRANTS_VERSION = 1;
export const LOGIN_GRANTS_FILE = "browser-login-grants.json";

type GrantField = { kind: SecretFieldKind; label?: string };

export type LoginGrant = {
  id: string;
  profileId: string;
  profileLabel?: string;
  origin: string;
  itemId: string;
  itemTitle: string;
  vault?: string;
  fields: GrantField[];
  createdAt: number;
  lastUsedAt?: number;
};

export type LoginGrantStore = {
  list(): LoginGrant[];
  find(input: { profileId: string; origin: string; itemId?: string; wants: readonly GrantField[] }): LoginGrant | null;
  findAll(input: { profileId: string; origin: string; wants: readonly GrantField[] }): LoginGrant[];
  remember(input: Omit<LoginGrant, "id" | "createdAt">): LoginGrant;
  touch(id: string): void;
  revoke(id: string): boolean;
};

function sameField(a: GrantField, b: GrantField): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind !== "field") return true;
  return (a.label ?? "").trim().toLowerCase() === (b.label ?? "").trim().toLowerCase();
}

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

const STALE_LOCK_MS = 10_000;
const LOCK_WAIT_MS = 15;
const LOCK_ATTEMPTS = 400;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withFileLock<T>(lockPath: string, run: () => T): T {
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
        continue;
      }
      if (age > STALE_LOCK_MS) {
        try { fs.rmdirSync(lockPath); } catch { }
        continue;
      }
      sleepSync(LOCK_WAIT_MS);
    }
  }
  if (!held) throw new Error("Could not take the browser login grant lock.");
  try {
    return run();
  } finally {
    try { fs.rmdirSync(lockPath); } catch { }
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
      console.error(`[engine] ignoring an unreadable browser login grant file: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  };

  const write = (grants: LoginGrant[]): void => {
    fs.mkdirSync(stateRoot, { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ version: LOGIN_GRANTS_VERSION, grants }, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
    try { fs.chmodSync(file, 0o600); } catch { }
  };

  const mutate = <T>(run: () => T): T => {
    fs.mkdirSync(stateRoot, { recursive: true });
    return withFileLock(lock, run);
  };

  const matches = (grant: LoginGrant, profileId: string, exact: string, wants: readonly GrantField[]): boolean =>
    grant.profileId === profileId &&
    grant.origin === exact &&
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
