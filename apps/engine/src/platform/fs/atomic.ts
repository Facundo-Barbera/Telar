import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// A unique temp file per write: two writers sharing `<file>.tmp` would interleave and publish a mix of both.
export function atomicWrite(file: string, value: unknown, mode = 0o600): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    fs.renameSync(temporary, file);
    fs.chmodSync(file, mode);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
