/**
 * The engine's one document write.
 *
 * EXTRACTED FROM `state.ts` RATHER THAN COPIED, and the reason is the shape of
 * the alternative: `spool/store.ts` needs this exact idiom, and `state.ts` will
 * import the spool store, so a spool module importing `state.ts` back would be a
 * cycle. The other option — a second inline `mkdir + tmp + rename` under
 * `spool/` — is how eight separate copies of this idiom accumulated in the
 * legacy tree, each free to drift on mode, on temp naming, or on whether it
 * cleans up after a failed write.
 *
 * A UNIQUE TEMP FILE, NOT `<file>.tmp`. Two writers racing on one document would
 * otherwise share a temp path and interleave, and the rename would publish a
 * half-written mix of both. Journals are the explicit O_APPEND exception and do
 * not come through here.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
