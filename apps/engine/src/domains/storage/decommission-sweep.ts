import fs from "node:fs";
import path from "node:path";
import { statePaths } from "../../platform/fs/state-paths";

function directorySize(directory: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return { bytes, files };
  }
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const inner = directorySize(full);
      bytes += inner.bytes;
      files += inner.files;
      continue;
    }
    try {
      bytes += fs.statSync(full).size;
      files += 1;
    } catch {
    }
  }
  return { bytes, files };
}

type SweptDirectory = { what: string; bytes: number; files: number };

export type DecommissionSweep = {
  removed: SweptDirectory[];
};

export function sweepSpoolAndLooms(engineRoot: string): DecommissionSweep {
  const resolved = path.resolve(engineRoot);
  const marker = statePaths(resolved).decommissionMarker;
  if (fs.existsSync(marker)) return { removed: [] };

  const targets: { what: string; directory: string }[] = [
    { what: "the Spool's store", directory: path.join(resolved, "spool") },
    { what: "the Looms", directory: path.join(path.dirname(resolved), "looms") },
  ];

  const removed: SweptDirectory[] = [];
  let failed = false;
  for (const { what, directory } of targets) {
    if (!fs.existsSync(directory)) continue;
    const { bytes, files } = directorySize(directory);
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      removed.push({ what, bytes, files });
    } catch {
      failed = true;
    }
  }

  if (!failed) {
    try {
      fs.mkdirSync(resolved, { recursive: true });
      fs.writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
    } catch {
    }
  }
  return { removed };
}

export function sweepReport(sweep: DecommissionSweep): string | undefined {
  if (sweep.removed.length === 0) return undefined;
  const parts = sweep.removed.map(({ what, bytes, files }) => {
    const size = bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
    return `${what} (${files.toLocaleString("en-US")} ${files === 1 ? "file" : "files"}, ${size})`;
  });
  return `Telar engine: removed ${parts.join(" and ")} — the Spool and the Looms are decommissioned (#501)`;
}

export type AgentRetirement =
  | { moved: true; to: string }
  | { moved: false }
  | { moved: false; failed: string };

function stampOf(at: number): string {
  return new Date(at).toISOString().replace(/[:.]/g, "-");
}

export function retireAgentStore(engineRoot: string, now: () => number = Date.now): AgentRetirement {
  const paths = statePaths(path.resolve(engineRoot));
  try {
    if (fs.existsSync(paths.agentRetiredMarker)) return { moved: false };
    const source = path.join(paths.root, "agent");
    let result: AgentRetirement = { moved: false };
    if (fs.existsSync(source)) {
      fs.mkdirSync(paths.retired, { recursive: true });
      let target = path.join(paths.retired, `agent-${stampOf(now())}`);
      for (let n = 1; fs.existsSync(target); n += 1) target = path.join(paths.retired, `agent-${stampOf(now())}-${n}`);
      fs.renameSync(source, target);
      result = { moved: true, to: target };
    }
    try {
      fs.writeFileSync(paths.agentRetiredMarker, `${new Date(now()).toISOString()}\n`, "utf8");
    } catch {
    }
    return result;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return { moved: false, failed: code ?? (error instanceof Error ? error.message : String(error)) };
  }
}

export function retireAgentReport(retirement: AgentRetirement): string | undefined {
  if (retirement.moved) {
    return `Telar engine: moved the built-in Agent's data to ${retirement.to} — the Agent was removed (#908); nothing was deleted`;
  }
  if ("failed" in retirement) {
    return `Telar engine: could not move the built-in Agent's data out of agent/ (${retirement.failed}); it is untouched and will be retried on the next start`;
  }
  return undefined;
}
