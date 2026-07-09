// Token/key store: ~/.telar/credentials.json, chmod 0600. Kept OUT of the
// account registry (accounts.json) so that file never carries a secret — the
// registry is safe to read and share; this half is the sensitive one. One
// token per account name. Hosting can bypass this entirely by exporting the
// real provider env var instead (accountEnv prefers an explicit env var).
import fs from "node:fs";
import path from "node:path";
import { telarDir } from "./manifest";

type SecretFile = { version: number; tokens: Record<string, string> };
const secretsFile = () => path.join(telarDir(), "credentials.json");

function read(): SecretFile {
  try {
    const data = JSON.parse(fs.readFileSync(secretsFile(), "utf8"));
    return { version: data.version ?? 1, tokens: data.tokens ?? {} };
  } catch {
    return { version: 1, tokens: {} };
  }
}

function write(data: SecretFile) {
  const file = secretsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.chmodSync(tmp, 0o600); // enforce even if a prior file relaxed the mode
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}

export function readSecret(name: string): string | undefined {
  return read().tokens[name];
}

export function writeSecret(name: string, token: string): void {
  const data = read();
  data.tokens[name] = token;
  write(data);
}

export function deleteSecret(name: string): boolean {
  const data = read();
  if (!(name in data.tokens)) return false;
  delete data.tokens[name];
  write(data);
  return true;
}
