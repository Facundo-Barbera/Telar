import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../../platform/fs/atomic";
import { RunConfiguration, RunConfigurationInput, RunError, newConfigId } from "./types";

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
    const parsed = RunConfigurationInput.safeParse(input);
    if (!parsed.success) {
      throw new RunError("invalid_request", parsed.error.issues[0]?.message ?? "that run configuration is not valid");
    }
    const valid = parsed.data;
    const document = this.read(projectId);
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

  remove(projectId: string, configId: string): void {
    const document = this.read(projectId);
    const next = document.configurations.filter((entry) => entry.id !== configId);
    if (next.length === document.configurations.length) {
      throw new RunError("not_found", `no run configuration ${configId} in this project`);
    }
    this.write(projectId, { configurations: next });
  }
}
