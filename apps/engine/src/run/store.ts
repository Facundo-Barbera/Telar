/**
 * Where a project's saved launches live.
 *
 * A FILE PER PROJECT, IN A DIRECTORY THE CALLER NAMES. The engine's state root
 * is flat — `projects.json`, `sessions/`, `mcp-servers.json` — and there is no
 * per-project directory to hang this off, so the store takes its directory as a
 * constructor argument instead of reaching into `statePaths`. That is not
 * squeamishness about a shared file: it is what lets every test in
 * `run-store.test.ts` point at a temp dir and exercise the real write path
 * rather than a mock of it.
 *
 * NOT ON THE PROJECT DOCUMENT. Configurations could have been a field on
 * `Project` in the protocol, and deliberately are not: that document is being
 * restructured elsewhere, and a launch list that grows per project would make
 * every project read carry every recipe. A project's runs are read when a human
 * opens the Run control, not on every listing.
 *
 * READS ARE FORGIVING, WRITES ARE NOT. A file that is missing reads as "no
 * configurations"; a file that is corrupt reads as an error naming the file,
 * because silently returning an empty list there would offer the human a fresh
 * empty editor over the top of work they can still see on disk.
 */
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../atomic";
import { RunConfiguration, RunConfigurationInput, RunError, newConfigId } from "./types";

/** Keep a project id from escaping into a path. Same rule as `ds/state-files`. */
function safeProjectId(projectId: string): string {
  const cleaned = projectId.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 120);
  if (!/[A-Za-z0-9]/.test(cleaned)) throw new RunError("invalid_request", "a project id must contain a letter or digit");
  return cleaned;
}

type Document = { configurations: RunConfiguration[] };

export class RunStore {
  constructor(
    private readonly dir: string,
    private readonly now: () => number = Date.now,
  ) {}

  private file(projectId: string): string {
    return path.join(this.dir, `${safeProjectId(projectId)}.json`);
  }

  private read(projectId: string): Document {
    const file = this.file(projectId);
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { configurations: [] };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new RunError("invalid_request", `the run configurations file for this project is not valid JSON (${file})`);
    }
    const configurations = (parsed as Document | null)?.configurations;
    if (!Array.isArray(configurations)) {
      throw new RunError("invalid_request", `the run configurations file for this project is missing its list (${file})`);
    }
    // A single unreadable entry should not hide the rest, but it must not be
    // invented either — parse strictly and name the index that failed.
    return {
      configurations: configurations.map((entry, index) => {
        const result = RunConfiguration.safeParse(entry);
        if (!result.success) {
          throw new RunError("invalid_request", `run configuration ${index + 1} in ${file} is not readable: ${result.error.issues[0]?.message ?? "unknown field"}`);
        }
        return result.data;
      }),
    };
  }

  private write(projectId: string, document: Document): void {
    atomicWrite(this.file(projectId), document);
  }

  list(projectId: string): RunConfiguration[] {
    return this.read(projectId).configurations;
  }

  get(projectId: string, configId: string): RunConfiguration {
    const found = this.read(projectId).configurations.find((entry) => entry.id === configId);
    if (!found) throw new RunError("not_found", `no run configuration ${configId} in this project`);
    return found;
  }

  create(projectId: string, input: RunConfigurationInput): RunConfiguration {
    // Validated HERE as well as at the door: the daemon is not the only caller,
    // and a `cwd` of `../../etc` must be unsaveable rather than merely unroutable.
    const parsed = RunConfigurationInput.safeParse(input);
    if (!parsed.success) {
      throw new RunError("invalid_request", parsed.error.issues[0]?.message ?? "that run configuration is not valid");
    }
    const valid = parsed.data;
    const document = this.read(projectId);
    // Names are how a human picks one out of a dropdown; two identical entries
    // there is a bug report waiting rather than a preference to respect.
    if (document.configurations.some((entry) => entry.name.trim() === valid.name.trim())) {
      throw new RunError("conflict", `this project already has a run configuration called "${valid.name.trim()}"`);
    }
    const at = this.now();
    const config: RunConfiguration = {
      ...valid,
      name: valid.name.trim(),
      id: newConfigId(),
      projectId,
      createdAt: at,
      updatedAt: at,
    };
    document.configurations.push(config);
    this.write(projectId, document);
    return config;
  }

  update(projectId: string, configId: string, patch: Partial<RunConfigurationInput>): RunConfiguration {
    const document = this.read(projectId);
    const index = document.configurations.findIndex((entry) => entry.id === configId);
    if (index === -1) throw new RunError("not_found", `no run configuration ${configId} in this project`);
    const name = patch.name?.trim() ?? document.configurations[index]!.name;
    if (document.configurations.some((entry) => entry.id !== configId && entry.name === name)) {
      throw new RunError("conflict", `this project already has a run configuration called "${name}"`);
    }
    const merged: RunConfiguration = {
      ...document.configurations[index]!,
      ...patch,
      name,
      updatedAt: this.now(),
    };
    const validated = RunConfiguration.safeParse(merged);
    if (!validated.success) {
      throw new RunError("invalid_request", validated.error.issues[0]?.message ?? "that run configuration is not valid");
    }
    document.configurations[index] = validated.data;
    this.write(projectId, document);
    return validated.data;
  }

  /**
   * Forget a recipe. It says nothing about a run launched from it: a live run
   * carries its own copy of the command and name, so deleting the recipe cannot
   * orphan or silently stop a server.
   */
  remove(projectId: string, configId: string): void {
    const document = this.read(projectId);
    const next = document.configurations.filter((entry) => entry.id !== configId);
    if (next.length === document.configurations.length) {
      throw new RunError("not_found", `no run configuration ${configId} in this project`);
    }
    this.write(projectId, { configurations: next });
  }
}
