// SERVER ONLY. Discovers TCP listeners without a shell and exposes only the
// process label and port needed by the embedded browser picker. No command
// arguments, environment, PIDs, or open files leave this module.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { LocalServerSuggestion } from "@/lib/local-server-contract";

const execFileP = promisify(execFile);
const CACHE_MS = 5_000;
const MAX_SUGGESTIONS = 40;

let cached: { expiresAt: number; servers: LocalServerSuggestion[] } | null = null;

function portFromListenerName(value: string): number | null {
  const match = value.trim().match(/:(\d+)(?:\s+\(LISTEN\))?$/);
  if (!match) return null;
  const port = Number(match[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : null;
}

/** Parse lsof's field output (`-Fpcn`). Exported so the platform boundary can
 * be covered without opening listeners during the test suite. */
export function parseLocalServerListeners(raw: string): LocalServerSuggestion[] {
  const byPort = new Map<number, LocalServerSuggestion>();
  let command = "Local server";

  for (const line of raw.split(/\r?\n/)) {
    if (!line) continue;
    const field = line[0];
    const value = line.slice(1).trim();
    if (field === "p") {
      command = "Local server";
      continue;
    }
    if (field === "c") {
      command = value || "Local server";
      continue;
    }
    if (field !== "n") continue;

    const port = portFromListenerName(value);
    if (port === null || byPort.has(port)) continue;
    byPort.set(port, {
      name: command,
      port,
      url: `http://localhost:${port}`,
    });
  }

  return [...byPort.values()]
    .sort((a, b) => a.port - b.port || a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS);
}

export async function discoverLocalServers(): Promise<LocalServerSuggestion[]> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.servers;

  try {
    const { stdout } = await execFileP(
      "lsof",
      ["+c", "40", "-nP", "-a", "-iTCP", "-sTCP:LISTEN", "-Fpcn"],
      {
        timeout: 3_000,
        maxBuffer: 2 << 20,
        env: process.env,
      },
    );
    const servers = parseLocalServerListeners(stdout);
    cached = { expiresAt: now + CACHE_MS, servers };
    return servers;
  } catch {
    // lsof is standard on macOS and common on Linux, but the feature remains
    // optional. Other systems still get a functional address bar.
    cached = { expiresAt: now + CACHE_MS, servers: [] };
    return [];
  }
}
