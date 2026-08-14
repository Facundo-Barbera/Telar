import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EngineClientError,
  type EngineClient,
  type EngineErrorCode,
} from "@telar/engine-client";
import { connectEngine } from "@telar/engine-client/node";

/**
 * The web process is only an authenticated engine client.  In
 * particular, this module does not import core state, a legacy session runner,
 * or any provider SDK.  The engine discovery document remains private under
 * the explicitly selected engine state root.
 */
/** Telar routes are available only through the launcher, which rejects legacy homes before Next boots. */
export function engineRootFromWebEnv(
  env: { TELAR_HOME?: string; TELAR_COCKPIT?: string } = process.env as { TELAR_HOME?: string; TELAR_COCKPIT?: string },
): string {
  if (env.TELAR_COCKPIT !== "1") {
    throw new EngineClientError("engine_unavailable", "Start the cockpit with bun run dev; ordinary web mode cannot access engine state.");
  }
  const telarHome = env.TELAR_HOME?.trim();
  if (!telarHome || !path.isAbsolute(telarHome)) {
    throw new EngineClientError(
      "engine_unavailable",
      "Set an absolute TELAR_HOME for the engine before opening the cockpit.",
    );
  }
  const canonicalHome = canonicalPath(telarHome);
  if (isLegacyTelarHome(canonicalHome)) {
    throw new EngineClientError(
      "engine_unavailable",
      "TELAR_HOME must not point at legacy Telar state; choose a dedicated Telar directory.",
    );
  }
  // Must stay the same subdirectory `engineRootFromEnv` (apps/engine/src/state.ts)
  // composes. The engine MIGRATES this directory on boot; the cockpit only reads
  // it, so it deliberately does not — a client that renamed the store would race
  // the process that owns it.
  return path.join(canonicalHome, "engine");
}

/** Resolve existing symlinks while allowing a newly-created dedicated home. */
function canonicalPath(input: string): string {
  const resolved = path.resolve(input);
  let existing = resolved;
  const missing: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  let canonical = fs.realpathSync.native(existing);
  for (const segment of missing) canonical = path.join(canonical, segment);
  return canonical;
}

/** Reject both legacy state homes after canonicalizing aliases such as symlinks. */
function isLegacyTelarHome(canonicalHome: string): boolean {
  const userHome = canonicalPath(os.homedir());
  return path.dirname(canonicalHome) === userHome && [".telar", ".telar-dev"].includes(path.basename(canonicalHome));
}

export async function engineClient(): Promise<EngineClient> {
  return connectEngine(engineRootFromWebEnv());
}

const statusByCode: Record<EngineErrorCode, number> = {
  engine_unavailable: 503,
  engine_unauthorized: 502,
  engine_locked: 503,
  // 409, not 400: the request was well-formed and the client is not at fault —
  // it is simply speaking a protocol version this engine no longer answers.
  protocol_mismatch: 409,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  worker_unavailable: 503,
  provider_unavailable: 503,
  driver_failed: 502,
  internal_error: 500,
};

export function engineErrorResponse(error: unknown): Response {
  if (error instanceof EngineClientError) {
    return Response.json(
      { error: { code: error.code, message: error.message } },
      { status: statusByCode[error.code] },
    );
  }
  return Response.json(
    { error: { code: "internal_error", message: "The engine adapter failed." } },
    { status: 500 },
  );
}

export async function requestObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new EngineClientError("invalid_request", "Request body must be a JSON object.");
  }
}

export function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EngineClientError("invalid_request", `${label} is required.`);
  }
  return value;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, label);
}
