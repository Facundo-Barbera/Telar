/**
 * THE ONE FILE READ A TERMINAL'S KITTY IMAGE MAY ASK FOR (#884).
 *
 * fastfetch's `kitty-direct` logo does not send the image; it sends a PATH
 * (`t=f`) and expects the terminal to read the file. The emulator is a page
 * and cannot, so it asks here.
 *
 * NO NEW PRIVILEGE, and why: the request comes from a program already running
 * in the person's shell, as the person, and that program can read every file
 * this function can — it just asked Telar to do it instead. The bytes come
 * back only to the cockpit renderer that asked, which draws them; they are
 * never written into the PTY, and the answer to a refusal is one of kitty's
 * short codes with no path in it. The renderer itself gains nothing either:
 * it already opens shells that can `cat` the same file.
 *
 * WHAT IS STILL REFUSED, so a path cannot be turned into something other than
 * "read a PNG the person owns":
 *   - a path that is not absolute, or carries a NUL;
 *   - anything that is not a regular file, judged AFTER symlinks resolve and
 *     judged again on the opened descriptor, so a link swapped in between is
 *     caught (and `O_NOFOLLOW` refuses a link at the last component outright);
 *   - anything under /dev, /proc or /sys, whose "regular files" are live
 *     kernel state rather than images;
 *   - a file larger than the cap, or one that does not start with the PNG
 *     signature — kitty-direct is PNG only (`f=100`), and so is this.
 */
const fs = require("node:fs");
const path = require("node:path");

/** addon-image's own IIP limit: a logo is kilobytes, and nothing drawable in
 *  a terminal comes near this. */
const KITTY_FILE_LIMIT = 20_000_000;
const FORBIDDEN_ROOTS = ["/dev", "/proc", "/sys"];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Lower-cased because macOS volumes are case-insensitive by default: `/DEV`
 *  is `/dev` there, whatever the resolver hands back. */
function isForbiddenLocation(resolved) {
  const lower = resolved.toLowerCase();
  return FORBIDDEN_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`));
}

/**
 * Answers `{ ok: true, bytes }` or `{ ok: false, code }`. `code` is a kitty
 * error code and nothing else — the caller writes it back into the terminal,
 * and a program in that terminal must not learn anything a failed `open` of
 * its own would not have told it.
 */
async function readKittyImageFile(requested, { limit = KITTY_FILE_LIMIT, fsp = fs.promises } = {}) {
  if (typeof requested !== "string" || !path.isAbsolute(requested) || requested.includes("\0")) return { ok: false, code: "EINVAL" };
  if (isForbiddenLocation(path.normalize(requested))) return { ok: false, code: "EPERM" };
  let resolved;
  try {
    resolved = await fsp.realpath(requested);
  } catch {
    return { ok: false, code: "ENOENT" };
  }
  if (isForbiddenLocation(resolved)) return { ok: false, code: "EPERM" };
  let handle;
  try {
    handle = await fsp.open(resolved, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (fs.constants.O_NONBLOCK ?? 0));
  } catch {
    return { ok: false, code: "ENOENT" };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, code: "EINVAL" };
    if (stat.size > limit) return { ok: false, code: "EFBIG" };
    // Read one byte past the cap, so a file that grew since the stat is caught.
    const buffer = Buffer.alloc(Math.min(stat.size, limit) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) return { ok: false, code: "EFBIG" };
    const bytes = buffer.subarray(0, bytesRead);
    if (bytes.length <= PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return { ok: false, code: "EBADPNG" };
    return { ok: true, bytes: new Uint8Array(bytes) };
  } catch {
    return { ok: false, code: "EIO" };
  } finally {
    await handle.close().catch(() => {});
  }
}

module.exports = { readKittyImageFile, isForbiddenLocation };
