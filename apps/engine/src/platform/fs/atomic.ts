import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function atomicWrite(file: string, value: unknown, mode = 0o600): void {
  atomicWriteText(file, `${JSON.stringify(value, null, 2)}\n`, mode);
}

// A unique temp file per write: two writers sharing `<file>.tmp` would interleave and publish a mix of both.
export function atomicWriteText(file: string, text: string | Uint8Array, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, text, { mode });
    fs.renameSync(temporary, file);
  } catch (error) {
    fs.rmSync(temporary, { force: true });
    throw error;
  }
  fs.chmodSync(file, mode);
}
