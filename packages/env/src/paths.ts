import { homedir } from "node:os";
import { join } from "node:path";

/** All state lives under TELAR_HOME (default ~/.telar), the same root the engine uses. */
export function telarHome(): string {
  return process.env.TELAR_HOME ?? join(homedir(), ".telar");
}

export function envStateDir(): string {
  return join(telarHome(), "env");
}

export function stateFilePath(): string {
  return join(envStateDir(), "state.json");
}

export function lockDirPath(): string {
  return join(envStateDir(), "state.lock");
}

export function sidecarDir(projectId: string): string {
  return join(telarHome(), "projects", projectId);
}

export function sidecarConfigPath(projectId: string): string {
  return join(sidecarDir(projectId), "env.yaml");
}

export function machineConfigPath(): string {
  return join(telarHome(), "config.yaml");
}
