import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "../../platform/fs/atomic";

// Its own 0600 file, never echoed: the settings document is served to every client.
export function dictationKeyFile(dictationDir: string): string {
  return path.join(dictationDir, "credentials.json");
}

export function readDictationKey(dictationDir: string): string | undefined {
  try {
    const stored = JSON.parse(fs.readFileSync(dictationKeyFile(dictationDir), "utf8")) as { key?: unknown };
    const key = typeof stored.key === "string" ? stored.key.trim() : "";
    return key ? key : undefined;
  } catch {
    return undefined;
  }
}

export function writeDictationKey(dictationDir: string, key: string | undefined): void {
  const trimmed = key?.trim();
  atomicWrite(dictationKeyFile(dictationDir), trimmed ? { key: trimmed } : {}, 0o600);
}

export function dictationCredential(dictationDir: string): { configured: boolean } {
  return { configured: readDictationKey(dictationDir) !== undefined };
}
