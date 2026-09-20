/**
 * WHAT THE SPOOL AND THE LOOMS LEFT ON DISK — issue #501, step 2.
 *
 * The code is gone; the data is not. Two directories outlive it: the engine's
 * own `spool/`, and `looms/` beside the engine root, which the SHELL wrote and
 * no surviving code has read since. Nothing left in this repository can open
 * either one, so what remains is not state — it is litter with no reader.
 *
 * A STARTUP STEP RATHER THAN A COMMAND, the judgement `executionHousekeeping`
 * already made for the same kind of leftover: the machines carrying these are
 * nobody's to administer, and a cleanup you have to know to run is a cleanup
 * that does not happen.
 *
 * ONCE, AND IT KNOWS IT. A marker file beside the engine root records that the
 * sweep ran, so a home that has already been swept does no filesystem walk on
 * every subsequent start. The marker is also what makes "once" honest rather
 * than incidental: without it, a directory recreated by some older build still
 * running against the same home would be deleted again and again, silently.
 *
 * NOTHING IS MIGRATED, and that is the owner's decision rather than an
 * omission — the live spool was confirmed empty before this was written
 * (0 items, 0 lanes, 0 threads, 0 shelf). There is no shape to carry forward
 * and nothing is kept "in case".
 *
 * IT SAYS WHAT WENT. Deleting a person's directories in silence leaves them no
 * evidence but the absence, which is indistinguishable from data loss to
 * whoever goes looking. One line, and only when something actually went — a
 * daemon that reports "removed nothing" on every start trains its reader to
 * skip the line that matters.
 */
import fs from "node:fs";
import path from "node:path";

/** The marker, beside the engine root. Its presence is the whole memory. */
const SWEPT_MARKER = "decommissioned-spool-looms";

/** What one directory held, so the deletion can say what it took. TOLERANT BY
 *  DESIGN: a tree being swept is a tree nothing else should be touching, and an
 *  unreadable corner of it must not stop the sweep. */
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
      // A file that vanished mid-walk counted for nothing anyway.
    }
  }
  return { bytes, files };
}

/** One directory that went, named as a person would recognise it. */
export type SweptDirectory = { what: string; bytes: number; files: number };

export type DecommissionSweep = {
  /** Empty when there was nothing to take — including on an already-swept home. */
  removed: SweptDirectory[];
};

/**
 * Remove the Spool's and the Looms' leftovers, once per home.
 *
 * `engineRoot` is `<TELAR_HOME>/engine`; `looms/` is the shell's, one level up
 * beside it. Both are addressed from that one argument so a test drives the
 * whole sweep with a temporary home and no environment at all.
 *
 * BEST-EFFORT, NEVER FATAL. A directory that cannot be removed — a permission,
 * a file locked by something else — leaves the home exactly as it was and the
 * marker unwritten, so the next start tries again. Failing a daemon's boot over
 * litter would be a worse outcome than the litter.
 */
export function sweepSpoolAndLooms(engineRoot: string): DecommissionSweep {
  const resolved = path.resolve(engineRoot);
  const marker = path.join(resolved, SWEPT_MARKER);
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
      // Left where it is, and the marker below is withheld so the next start
      // has another go rather than writing this home off as done.
      failed = true;
    }
  }

  if (!failed) {
    try {
      fs.mkdirSync(resolved, { recursive: true });
      fs.writeFileSync(marker, `${new Date().toISOString()}\n`, "utf8");
    } catch {
      // A marker we cannot write costs one directory walk on the next start,
      // which finds nothing and says nothing. Not worth a failure.
    }
  }
  return { removed };
}

/** The one line, composed where it can be tested without a daemon. `undefined`
 *  when nothing went, which is the caller's signal to stay quiet. */
export function sweepReport(sweep: DecommissionSweep): string | undefined {
  if (sweep.removed.length === 0) return undefined;
  const parts = sweep.removed.map(({ what, bytes, files }) => {
    const size = bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
    return `${what} (${files.toLocaleString("en-US")} ${files === 1 ? "file" : "files"}, ${size})`;
  });
  return `Telar engine: removed ${parts.join(" and ")} — the Spool and the Looms are decommissioned (#501)`;
}
