const fs = require("node:fs");
const path = require("node:path");

const KITTY_FILE_LIMIT = 20_000_000;
const FORBIDDEN_ROOTS = ["/dev", "/proc", "/sys"];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function isForbiddenLocation(resolved) {
  const lower = resolved.toLowerCase();
  return FORBIDDEN_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`));
}

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
